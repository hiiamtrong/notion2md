import { rmSync } from 'node:fs';
import { chromium, type BrowserContext } from 'playwright-core';
import { cloneProfile, keychainPassword, readCookies, type Profile } from './chrome.ts';
import { CliError } from './errors.ts';
import { apiError, createPacer } from './notion.ts';
import type { Api, ApiResponse } from './types.ts';

export interface SessionOptions {
  root: string;
  profile: Profile;
  channel: string;
  headed: boolean;
  /** A Notion page to open first: the API is called from inside it, so it must be on a Notion host. */
  url: string;
  timeoutMs: number;
  log: (msg: string) => void;
  /** Return true when a first Ctrl-C was handled (a crawl keeps what it fetched). The second one always quits. */
  onSigint?: () => boolean;
}

/** A GET with the profile's cookies: signed Notion file URLs answer 403 without them. */
export type Download = (url: string) => Promise<Response>;

const NOTION_FILE_HOST = /^https:\/\/([\w-]+\.)*(notion\.com|notion\.so|notionusercontent\.com)\//;
const S3_HOST = /^https:\/\/[\w.-]+\.amazonaws\.com\//;

/** Which cookie policy a signed file URL gets: a Notion host needs the profile's cookies, S3 carries its own signature. */
export function fileHost(url: string): 'notion' | 's3' | undefined {
  if (NOTION_FILE_HOST.test(url)) return 'notion';
  if (S3_HOST.test(url)) return 's3';
  return undefined;
}

/**
 * A copy of a profile can lose its cookies: Chrome decrypts them per profile and drops the ones it cannot
 * read, which looks exactly like a logged out profile. Say which of the two it is.
 */
export function checkLogin(profile: Profile, kept: number, live: number): void {
  if (live > 0) return;
  if (kept > 0) {
    throw new CliError(
      'COOKIES_UNREADABLE',
      `The copy of profile "${profile.dir}" holds none of the ${kept} Notion cookies on disk`,
      'Log in to Notion again in that Chrome profile, then run again: the cookies are expired, or this Chrome will not decrypt them outside their own profile',
      4,
    );
  }
  throw notLoggedIn(profile, 'holds no Notion cookies');
}

const notLoggedIn = (profile: Profile, why: string) =>
  new CliError('AUTH_REQUIRED', `Profile "${profile.dir}" (${profile.name}) ${why}`, 'Log in to Notion once in that Chrome profile, or pick another with --profile', 4);

/** Runs `work` with a logged-in Notion API, and removes the cookie copy and the browser afterwards, signals included. */
export async function withSession<T>(o: SessionOptions, work: (api: Api, download: Download) => Promise<T>): Promise<T> {
  const { profile, log } = o;
  // The cookie copy exists before Chrome does, so it is removable from the first instant, Ctrl-C included.
  const { tmp, cookies: kept } = cloneProfile(o.root, profile.dir, ['notion.so', 'notion.com', 'notion.site']);
  // Read before Chrome opens the copy and drops what it cannot decrypt, then handed to Chrome as plain cookies.
  const password = o.channel === 'chrome' ? keychainPassword() : undefined;
  const decrypted = password ? readCookies(tmp, profile.dir, password) : [];
  let ctx: BrowserContext | undefined;
  const cleanup = async () => {
    await ctx?.close().catch(() => {});
    rmSync(tmp, { recursive: true, force: true });
  };
  let interrupts = 0;
  process.on('SIGINT', () => {
    if (interrupts++ === 0 && o.onSigint?.()) return;
    cleanup().finally(() => process.exit(130));
  });
  for (const [signal, code] of [['SIGTERM', 143], ['SIGHUP', 129]] as const) {
    process.on(signal, () => cleanup().finally(() => process.exit(code)));
  }

  try {
    log(`Launching ${o.channel}${o.headed ? '' : ' (headless)'}`);
    try {
      ctx = await chromium.launchPersistentContext(tmp, {
        channel: o.channel,
        headless: !o.headed,
        // Playwright's own handlers exit at once and would skip the cleanup of the cookie copy, so signals are handled above.
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        timeout: Math.min(o.timeoutMs, 60_000),
        ignoreDefaultArgs: ['--use-mock-keychain', '--enable-automation'],
        args: [`--profile-directory=${profile.dir}`],
      });
    } catch (e) {
      throw new CliError('BROWSER_FAILED', (e as Error).message.split('\n')[0]!, `Is "${o.channel}" installed? Try --channel msedge|chromium`, 5);
    }

    const page = ctx.pages()[0] ?? (await ctx.newPage());
    if (decrypted.length) await ctx.addCookies(decrypted);
    checkLogin(profile, kept, (await ctx.cookies()).length);
    log(`Opening ${o.url}`);
    await page.goto(o.url, { waitUntil: 'domcontentloaded' });
    if (/\/login|\/onboarding/.test(new URL(page.url()).pathname)) {
      throw notLoggedIn(profile, 'is not logged in to Notion');
    }
    // Fetched inside the page: same origin, real Chrome network stack, cookies of the profile.
    const pacer = createPacer();
    const api: Api = async (endpoint, body) => {
      await pacer.wait();
      const res = await page.evaluate(async ([ep, payload]: [string, unknown]): Promise<{ ok: true; json: ApiResponse; limited: number } | { ok: false; status: number; text: string; limited: number }> => {
        // 429 is Notion's rate limit: wait as long as it asks (Retry-After), else back off 2s, 4s, 8s...
        let limited = 0;
        for (let attempt = 1; ; attempt++) {
          const r = await fetch(`/api/v3/${ep}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
          if (r.ok) return { ok: true, json: await r.json(), limited };
          if ((r.status !== 429 && r.status < 500) || attempt === 6) return { ok: false, status: r.status, text: (await r.text()).slice(0, 200), limited };
          if (r.status === 429) limited++;
          const asked = Number(r.headers.get('retry-after'));
          await new Promise((done) => setTimeout(done, Math.min(asked > 0 ? asked : 2 ** attempt, 60) * 1000));
        }
      }, [endpoint, body] as [string, unknown]);
      if (res.limited) {
        pacer.slowDown();
        log(`Rate limited by Notion, now ${pacer.delay} ms between requests`);
      }
      if (!res.limited) pacer.succeeded();
      if (res.ok) return res.json;
      throw apiError(endpoint, res.status, res.text);
    };
    return await work(api, async (url) => {
      const host = fileHost(url);
      if (!host) {
        throw new CliError('BAD_INPUT', `Refusing to download from ${url.slice(0, 80)}`, 'Only Notion file hosts are fetched', 2);
      }
      const cookies = host === 'notion' ? (await ctx!.cookies(url)).map((c) => `${c.name}=${c.value}`).join('; ') : '';
      return fetch(url, cookies ? { headers: { Cookie: cookies } } : undefined);
    });
  } finally {
    await cleanup();
  }
}
