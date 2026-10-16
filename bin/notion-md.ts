#!/usr/bin/env node
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type BrowserContext } from 'playwright-core';
import { cloneProfile, defaultChromeRoot, listProfiles, resolveProfile } from '../src/chrome.ts';
import { CliError } from '../src/errors.ts';
import { pageTitle, pageUrl, toMarkdown } from '../src/markdown.ts';
import { apiError, createPacer, loadTree, parseDepth, parseMaxPages, parsePageId, parseTimeout } from '../src/notion.ts';
import { NO_ACCESS_FILE, writeTree } from '../src/tree.ts';
import type { Api, ApiResponse } from '../src/types.ts';

const HELP = `notion-md: dump a Notion page to Markdown using a logged-in Chrome profile (headless Playwright)

USAGE
  notion-md <url|page-id> [options]   Markdown to stdout
  notion-md profiles [--json]         List Chrome profiles you can pass to --profile

OPTIONS
  -p, --profile <p>        Chrome profile: dir ("Profile 70"), number (70), display name or email.
                           Default: the profile Chrome used last.
  -d, --depth <n|all>      Follow pages from the root: nested pages, pages it links to, databases, and a
                           database's rows (each hop is one level). Default 0: the page only, links stay URLs.
                           Depth above 0 writes a folder (needs --out <dir>), see FOLDER OUTPUT.
      --max-pages <n|all>  Stop after fetching n pages (default 1000). What was fetched is still written.
  -o, --out <path>         Depth 0: write Markdown to this file and print its path instead of the Markdown.
                           Depth above 0: the output folder.
      --json               Machine output: {ok,id,title,url,profile,truncated,skipped,noAccess,pages,markdown|out}
                           (errors: {ok:false,error:{code,message,hint}})
      --user-data-dir <d>  Chrome user data dir to read profiles from (default: platform Chrome dir)
      --channel <c>        Browser channel: chrome (default), msedge, chromium
      --headed             Show the browser (for debugging)
      --timeout <sec>      Overall time limit (default 90, or 1800 when --depth is above 0).
                           On timeout a crawl stops and writes what it has
      --progress           Print progress to stderr (automatic when stderr is a terminal)
  -h, --help / -v, --version

BEHAVIOR
  stdout carries only the result. Errors go to stderr as "error[CODE]: message" plus a "hint:" line,
  and nothing is ever prompted. The Chrome profile is copied to a temp dir (cookies only) and deleted
  afterwards, so Chrome may stay open and your profile is never modified.

FOLDER OUTPUT
  One .md per page, written once. Folders follow what a page contains (nested pages, databases, rows):
    out/Knowledge Map.md
    out/Knowledge Map/Repo Map.md             a database: a list of its rows
    out/Knowledge Map/Repo Map/my-service.md a row: its fields (Status, Owner, ...), then its body
    out/_linked/Code Review Criteria.md       a page reached only through a link, kept flat
    out/_no-access.md                         pages Notion refused, and the page that linked to them
  Links to fetched pages are relative file links, other pages keep their notion.so URL.
  Existing files with the same names are overwritten. Pages are fetched one by one (about 0.5 s each,
  slower under rate limits), so a big workspace takes minutes.
  Stopped early (--max-pages, --timeout, Ctrl-C once): a warning is printed, what was fetched is written,
  exit 0, and --json reports "truncated" and "skipped". Ctrl-C twice quits at once.
  A rate limit (429) is retried with waits and the pace slows down. If it keeps failing, or another
  error hits, the pages fetched so far are written, the error is printed and the exit is 1.

EXIT CODES
  0 ok, 1 other, 2 bad usage/input, 3 profile not found, 4 not logged in or no access, 5 browser failed

EXAMPLES
  notion-md "https://app.notion.com/p/team/Knowledge-Map-0123..." --profile 70
  notion-md 0123456789abcdef0123456789abcdef -p me@company.com -o map.md
  notion-md "$URL" -p 70 --depth 1 --out ./export
  notion-md "$URL" -p 70 --depth all --out ./knowledge-map --max-pages 300
  notion-md profiles --json
`;

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    profile: { type: 'string', short: 'p' },
    depth: { type: 'string', short: 'd', default: '0' },
    out: { type: 'string', short: 'o' },
    json: { type: 'boolean', default: false },
    'user-data-dir': { type: 'string' },
    channel: { type: 'string', default: 'chrome' },
    headed: { type: 'boolean', default: false },
    timeout: { type: 'string' },
    'max-pages': { type: 'string' },
    progress: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
  },
});

const GRACE_SEC = 30;
const stop = new AbortController();
let interrupted = false;
const started = Date.now();
const showProgress = opt.progress || process.stderr.isTTY;
const log = (msg: string) => {
  if (showProgress) process.stderr.write(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${msg}\n`);
};

const short = (t: string) => (t.length > 70 ? `${t.slice(0, 69)}…` : t);

const print = (s: string) => process.stdout.write(s.endsWith('\n') ? s : `${s}\n`);

async function profilesCommand() {
  const profiles = listProfiles(opt['user-data-dir'] ?? defaultChromeRoot());
  if (opt.json) return print(JSON.stringify(profiles, null, 2));
  for (const p of profiles) print(`${p.dir}\t${p.name}\t${p.email ?? ''}${p.lastUsed ? '\t(last used)' : ''}`);
}

async function dumpCommand(input: string) {
  const depth = parseDepth(opt.depth);
  if (depth > 0 && !opt.out) throw new CliError('BAD_INPUT', '--depth above 0 writes a folder', 'Add --out <dir>', 2);
  const pageId = parsePageId(input);
  const timeoutSec = parseTimeout(opt.timeout, depth);
  const maxPages = parseMaxPages(opt['max-pages']);
  const timeout = timeoutSec * 1000;
  if (depth > 0) {
    try {
      mkdirSync(opt.out!, { recursive: true });
    } catch (e) {
      throw new CliError('BAD_INPUT', `Cannot use --out "${opt.out}": ${(e as NodeJS.ErrnoException).code}`, 'Pass a folder path that can be created', 2);
    }
  }
  const url = /^https?:/.test(input.trim()) ? input.trim() : `https://www.notion.so/${pageId.replaceAll('-', '')}`;

  const root = opt['user-data-dir'] ?? defaultChromeRoot();
  const profile = resolveProfile(root, opt.profile);
  log(`Using ${profile.dir} (${profile.name}${profile.email ? `, ${profile.email}` : ''})`);
  const tmp = cloneProfile(root, profile.dir);
  let ctx: BrowserContext | undefined;
  const cleanup = async () => {
    await ctx?.close().catch(() => {});
    rmSync(tmp, { recursive: true, force: true });
  };
  // With a crawl, the first Ctrl-C stops after the current page and keeps what was fetched, the second quits.
  process.on('SIGINT', () => {
    if (depth > 0 && !stop.signal.aborted) {
      interrupted = true;
      stop.abort();
      log('Stopping after the current page, press Ctrl-C again to quit now');
    } else cleanup().finally(() => process.exit(130));
  });
  for (const [signal, code] of [['SIGTERM', 143], ['SIGHUP', 129]] as const) {
    process.on(signal, () => cleanup().finally(() => process.exit(code)));
  }

  try {
    let context: BrowserContext;
    log(`Launching ${opt.channel}${opt.headed ? '' : ' (headless)'}`);
    try {
      // The mock keychain flag would make Chrome unable to decrypt the cloned cookies.
      context = ctx = await chromium.launchPersistentContext(tmp, {
        channel: opt.channel,
        headless: !opt.headed,
        // Playwright's own handlers exit at once and would skip the cleanup of the cookie copy, so signals are handled below.
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        timeout: Math.min(timeout, 60_000),
        ignoreDefaultArgs: ['--use-mock-keychain', '--enable-automation'],
        args: [`--profile-directory=${profile.dir}`],
      });
    } catch (e) {
      throw new CliError('BROWSER_FAILED', (e as Error).message.split('\n')[0], `Is "${opt.channel}" installed? Try --channel msedge|chromium`, 5);
    }

    const work = async () => {
      const page = context.pages()[0] ?? (await context.newPage());
      log(`Opening ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      if (/\/login|\/onboarding/.test(new URL(page.url()).pathname)) {
        throw new CliError('AUTH_REQUIRED', `Profile "${profile.dir}" (${profile.name}) is not logged in to Notion`, 'Log in to Notion once in that Chrome profile, or pick another with --profile', 4);
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
      return loadTree(api, pageId, {
        depth,
        maxPages,
        signal: stop.signal,
        onPage: (id, store, level) => {
          const n = store.expanded.size;
          const kind = store.blocks[id]?.type === 'page' ? '' : ' (database)';
          log(`Fetched ${n} page${n > 1 ? 's' : ''}: ${'  '.repeat(level)}${short(pageTitle(store, id) || 'Untitled')}${kind}`);
        },
      });
    };

    let hardTimer: NodeJS.Timeout;
    const hardLimit = new Promise<never>((_, reject) => {
      hardTimer = setTimeout(() => reject(new CliError('TIMEOUT', `Gave up after ${timeoutSec + GRACE_SEC}s`, 'Raise --timeout', 1)), timeout + GRACE_SEC * 1000);
    });
    const softTimer = setTimeout(() => stop.abort(), timeout);
    const store = await Promise.race([work(), hardLimit]).finally(() => {
      clearTimeout(softTimer);
      clearTimeout(hardTimer);
    });
    const skipped = store.skipped.length;
    const reason = store.truncated === 'aborted' ? (interrupted ? 'interrupted' : 'timeout') : (store.truncated ?? null);
    const noAccess = [...store.noAccess].map(([id, from]) => ({ id, title: pageTitle(store, id) || null, url: pageUrl(id), from }));
    if (store.truncated === 'max-pages') {
      process.stderr.write(`warning: stopped at --max-pages ${maxPages}; ${skipped} more pages were found but not fetched\n`);
    } else if (store.truncated === 'aborted') {
      process.stderr.write(`warning: ${interrupted ? 'stopped by Ctrl-C' : `--timeout ${timeoutSec}s reached`}; ${skipped} more pages were found but not fetched\n`);
    }
    if (store.truncated === 'error') {
      process.stderr.write(`warning: stopped after an error, ${skipped} pages not fetched: ${store.error}\n`);
      process.exitCode = 1;
    }
    if (store.noAccess.size) process.stderr.write(`warning: ${store.noAccess.size} pages had no access and were skipped${depth > 0 ? ` (listed in ${NO_ACCESS_FILE})` : ''}\n`);

    const title = pageTitle(store, pageId);
    log(depth > 0 ? `Writing ${store.expanded.size} file${store.expanded.size > 1 ? 's' : ''} to ${resolve(opt.out!)}` : 'Rendering Markdown');
    if (depth > 0) {
      const paths = writeTree(store, pageId, opt.out!);
      const out = resolve(opt.out!);
      if (opt.json) {
        const pages = [...paths].map(([id, path]) => ({ id, title: pageTitle(store, id), path }));
        print(JSON.stringify({ ok: !store.error, id: pageId, title, url, profile: profile.dir, out, truncated: reason, skipped, error: store.error ?? null, noAccess, pages }));
      } else print(out);
      log('Done');
      return;
    }
    const markdown = toMarkdown(store, pageId);
    if (opt.json) {
      print(JSON.stringify({ ok: true, id: pageId, title, url, profile: profile.dir, truncated: null, skipped: 0, noAccess: [], pages: [{ id: pageId, title }], markdown }));
    } else if (opt.out) {
      writeFileSync(opt.out, markdown);
      print(resolve(opt.out));
    } else {
      print(markdown);
    }
    log('Done');
  } finally {
    await cleanup();
  }
}

try {
  if (opt.help) print(HELP);
  else if (opt.version) print('0.1.0');
  else if (positionals[0] === 'profiles') await profilesCommand();
  else if (positionals.length === 1) await dumpCommand(positionals[0]);
  else throw new CliError('BAD_INPUT', 'Expected exactly one page URL or id', 'See notion-md --help', 2);
} catch (e) {
  const err = e instanceof CliError ? e : new CliError('ERROR', (e as Error).message, undefined, 1);
  process.stderr.write(`error[${err.code}]: ${err.message}\n${err.hint ? `hint: ${err.hint}\n` : ''}`);
  if (opt.json) print(JSON.stringify({ ok: false, error: { code: err.code, message: err.message, hint: err.hint ?? null } }));
  process.exitCode = err.exit;
}
