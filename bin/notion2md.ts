#!/usr/bin/env node
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { assetLink, collectAssets, encodePath, saveAssets, signedUrls } from '../src/assets.ts';
import { defaultChromeRoot, listProfiles, resolveProfile } from '../src/chrome.ts';
import { CliError } from '../src/errors.ts';
import { findRows, parseLimit, parseWheres } from '../src/find.ts';
import { JOURNAL_FILE } from '../src/journal.ts';
import { pageTitle, pageUrl, toMarkdown } from '../src/markdown.ts';
import { loadTree, parseConcurrency, parseDepth, parseMaxPages, parsePageId, parseTimeout } from '../src/notion.ts';
import { withSession } from '../src/session.ts';
import { NO_ACCESS_FILE, writeTree } from '../src/tree.ts';

const HELP = `notion2md: dump a Notion page to Markdown using a logged-in Chrome profile (headless Playwright)

USAGE
  notion2md <url|page-id> [options]   Markdown to stdout
  notion2md find <database-url> --where "Name=value" [--where ...] [--limit 20] [--json]
                                      Rows of a database matching every --where, one per line
  notion2md profiles [--json]         List Chrome profiles you can pass to --profile

OPTIONS
  -p, --profile <p>        Chrome profile: dir ("Profile 70"), number (70), display name or email.
                           Default: the profile Chrome used last.
  -d, --depth <n|all>      Follow pages from the root: nested pages, pages it links to, databases, and a
                           database's rows (each hop is one level). Default 0: the page only, links stay URLs.
                           Depth above 0 writes a folder (needs --out <dir>), see FOLDER OUTPUT.
      --max-pages <n|all>  Stop after fetching n pages (default 1000). What was fetched is still written.
      --concurrency <n>    Pages fetched at the same time, 1 to 16 (default 1). Rate limits (429) slow every fetch down.
      --keep-journal       Keep the journal after a crawl that finished, so a later --resume only renders again
                           (for example after an update of this tool) without fetching pages. It can be hundreds of MB.
      --resume             Continue the crawl that was stopped or killed in --out: pages already fetched are read from
                           its journal (.notion2md-journal.jsonl) instead of fetched again. Needs --depth above 0.
  -o, --out <path>         Depth 0: write Markdown to this file and print its path instead of the Markdown.
                           Depth above 0: the output folder.
      --assets <dir>       Download images, attached files and page covers into this dir and link them locally.
                           Without it, an image points at notion.so/image (needs a signed in session) and an
                           attached file keeps its attachment: source, which nothing outside Notion opens.
      --json               Machine output: {ok,id,title,url,profile,truncated,skipped,noAccess,pages,markdown|out}
                           (errors: {ok:false,error:{code,message,hint}})
      --user-data-dir <d>  Chrome user data dir to read profiles from (default: platform Chrome dir)
      --channel <c>        Browser channel: chrome (default), msedge, chromium
      --headed             Show the browser (for debugging)
      --timeout <sec>      Time limit for fetching pages (default 90, or 1800 when --depth is above 0).
                           Attachments downloaded with --assets run after that clock.
                           On timeout a crawl stops and writes what it has
      --progress           Print progress to stderr (automatic when stderr is a terminal)
  -h, --help / -v, --version

FIND
  --where "Name=value" filters on a database property, repeatable: every one must match. A text property
  matches part of the text, a number one needs the same number, and select, multi_select and status need
  one of their options (ignoring case). Title, text, number, Task ID style numbers, select, multi_select and
  status work; date, person and relation properties do not. It prints <url> and <title> per row, separated
  by a tab, capped at --limit (default 20). A warning on stderr says when more rows matched than printed.

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
  Existing files with the same names are overwritten. Pages are fetched one by one by default (about 0.5 s each,
  slower under rate limits, faster with --concurrency), so a big workspace takes minutes.
  Stopped early (--max-pages, --timeout, Ctrl-C once): a warning is printed, what was fetched is written,
  exit 0, and --json reports "truncated" and "skipped". Ctrl-C twice quits at once.
  A rate limit (429) is retried with waits and the pace slows down. If it keeps failing, or another
  error hits, the pages fetched so far are written, the error is printed and the exit is 1.

EXIT CODES
  0 ok, 1 other, 2 bad usage/input, 3 profile not found, 4 not logged in or no access, 5 browser failed

EXAMPLES
  notion2md "https://app.notion.com/p/team/Knowledge-Map-0123..." --profile 70
  notion2md 0123456789abcdef0123456789abcdef -p me@company.com -o map.md
  notion2md "$URL" -p 70 --depth 1 --out ./export
  notion2md "$URL" -p 70 --depth all --out ./knowledge-map --max-pages 300
  notion2md profiles --json
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
    concurrency: { type: 'string' },
    resume: { type: 'boolean', default: false },
    assets: { type: 'string' },
    'keep-journal': { type: 'boolean', default: false },
    where: { type: 'string', multiple: true },
    limit: { type: 'string' },
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
  const concurrency = parseConcurrency(opt.concurrency);
  if (opt.resume && depth === 0) throw new CliError('BAD_INPUT', '--resume continues a folder crawl', 'Add --depth above 0 and --out <dir>', 2);
  const journal = depth > 0 ? join(opt.out!, JOURNAL_FILE) : undefined;
  const timeout = timeoutSec * 1000;
  if (depth > 0) {
    try {
      mkdirSync(opt.out!, { recursive: true });
    } catch (e) {
      throw new CliError('BAD_INPUT', `Cannot use --out "${opt.out}": ${(e as NodeJS.ErrnoException).code}`, 'Pass a folder path that can be created', 2);
    }
  }
  const url = /^https?:/.test(input.trim()) ? input.trim() : `https://www.notion.so/${pageId.replaceAll('-', '')}`;
  const assetsDir = opt.assets ? resolve(opt.assets) : undefined;
  if (assetsDir) {
    try {
      mkdirSync(assetsDir, { recursive: true });
    } catch (e) {
      throw new CliError('BAD_INPUT', `Cannot use --assets "${opt.assets}": ${(e as NodeJS.ErrnoException).code}`, 'Pass a folder path that can be created', 2);
    }
  }

  const root = opt['user-data-dir'] ?? defaultChromeRoot();
  const profile = resolveProfile(root, opt.profile);
  log(`Using ${profile.dir} (${profile.name}${profile.email ? `, ${profile.email}` : ''})`);
  const { store, assets } = await withSession({
    root, profile, channel: opt.channel, headed: opt.headed, url, timeoutMs: timeout, log,
    // With a crawl, the first Ctrl-C stops after the current page and keeps what was fetched, the second quits.
    onSigint: () => {
      if (depth === 0 || stop.signal.aborted) return false;
      interrupted = true;
      stop.abort();
      log('Stopping after the current page, press Ctrl-C again to quit now');
      return true;
    },
  }, async (api, download) => {
    let hardTimer: NodeJS.Timeout;
    const hardLimit = new Promise<never>((_, reject) => {
      hardTimer = setTimeout(() => reject(new CliError('TIMEOUT', `Gave up after ${timeoutSec + GRACE_SEC}s`, depth > 0 ? 'Raise --timeout, or run again with --resume to continue where it stopped' : 'Raise --timeout', 1)), timeout + GRACE_SEC * 1000);
    });
    const softTimer = setTimeout(() => stop.abort(), timeout);
    const store = await Promise.race([loadTree(api, pageId, {
      depth,
      maxPages,
      concurrency,
      journal,
      resume: opt.resume,
      signal: stop.signal,
      onPage: (id, store, level) => {
        const n = store.expanded.size;
        const kind = store.blocks[id]?.type === 'page' ? '' : ' (database)';
        log(`Fetched ${n} page${n > 1 ? 's' : ''}: ${'  '.repeat(level)}${short(pageTitle(store, id) || 'Untitled')}${kind}`);
      },
    }), hardLimit]).finally(() => {
      clearTimeout(softTimer);
      clearTimeout(hardTimer);
    });
    if (!assetsDir) return { store, assets: undefined };
    const all = collectAssets(store);
    log(`Downloading ${all.length} attachment${all.length === 1 ? '' : 's'} to ${assetsDir}`);
    return { store, assets: await saveAssets(all, await signedUrls(api, all, log), assetsDir, download, log) };
  });
  const skipped = store.skipped.length;
  const reason = store.truncated === 'aborted' ? (interrupted ? 'interrupted' : 'timeout') : (store.truncated ?? null);
  const noAccess = [...store.noAccess].map(([id, from]) => ({ id, title: pageTitle(store, id) || null, url: pageUrl(id), from }));
  if (store.truncated === 'max-pages') {
    process.stderr.write(`warning: stopped at --max-pages ${maxPages}; ${skipped} more pages were found but not fetched (add --resume --max-pages <n|all> to continue)\n`);
  } else if (store.truncated === 'aborted') {
    process.stderr.write(`warning: ${interrupted ? 'stopped by Ctrl-C' : `--timeout ${timeoutSec}s reached`}; ${skipped} more pages were found but not fetched${depth > 0 ? ' (add --resume to continue)' : ''}\n`);
  }
  if (store.truncated === 'error') {
    process.stderr.write(`warning: stopped after an error, ${skipped} pages not fetched: ${store.error}${depth > 0 ? ' (add --resume to continue)' : ''}\n`);
    process.exitCode = 1;
  }
  if (store.noAccess.size) process.stderr.write(`warning: ${store.noAccess.size} pages had no access and were skipped${depth > 0 ? ` (listed in ${NO_ACCESS_FILE})` : ''}\n`);
  if (assets?.failed) {
    process.stderr.write(`warning: ${assets.failed} attachment${assets.failed === 1 ? '' : 's'} could not be downloaded\n`);
    process.exitCode = 1;
  }
  const assetsJson = assets && assetsDir ? { dir: assetsDir, saved: assets.names.size, failed: assets.failed } : null;

  const title = pageTitle(store, pageId);
  log(depth > 0 ? `Writing ${store.expanded.size} file${store.expanded.size > 1 ? 's' : ''} to ${resolve(opt.out!)}` : 'Rendering Markdown');
  if (depth > 0) {
    const paths = writeTree(store, pageId, opt.out!, assets && assetsDir ? { dir: assetsDir, names: assets.names } : undefined);
    if (journal && !store.truncated && !opt['keep-journal']) rmSync(journal, { force: true });
    const out = resolve(opt.out!);
    if (opt.json) {
      const pages = [...paths].map(([id, path]) => ({ id, title: pageTitle(store, id), path }));
      print(JSON.stringify({ ok: !store.error && !assets?.failed, id: pageId, title, url, profile: profile.dir, out, truncated: reason, skipped, error: store.error ?? null, noAccess, assets: assetsJson, pages }));
    } else print(out);
    log('Done');
    return;
  }
  const assetHref = assets && assetsDir
    ? (blockId: string) => {
        const name = assets.names.get(blockId);
        if (!name) return undefined;
        // Relative to the Markdown file when one is written, absolute otherwise: stdout has no folder of its own.
        return opt.out ? assetLink(dirname(resolve(opt.out)), assetsDir, name) : encodePath(join(assetsDir, name));
      }
    : undefined;
  const markdown = toMarkdown(store, pageId, pageUrl, assetHref);
  if (opt.json) {
    print(JSON.stringify({ ok: !assets?.failed, id: pageId, title, url, profile: profile.dir, truncated: null, skipped: 0, noAccess: [], assets: assetsJson, pages: [{ id: pageId, title }], markdown }));
  } else if (opt.out) {
    writeFileSync(opt.out, markdown);
    print(resolve(opt.out));
  } else {
    print(markdown);
  }
  log('Done');
}

async function findCommand(input: string) {
  const dbId = parsePageId(input);
  const wheres = parseWheres(opt.where ?? []);
  if (!wheres.length) throw new CliError('BAD_INPUT', 'A find needs a property to look for', 'Pass --where "Task ID=6660" (repeat it to match more than one)', 2);
  const limit = parseLimit(opt.limit);
  const timeoutSec = parseTimeout(opt.timeout, 0);
  const url = /^https?:/.test(input.trim()) ? input.trim() : pageUrl(dbId);
  const root = opt['user-data-dir'] ?? defaultChromeRoot();
  const profile = resolveProfile(root, opt.profile);
  log(`Using ${profile.dir} (${profile.name}${profile.email ? `, ${profile.email}` : ''})`);
  const found = await withSession({ root, profile, channel: opt.channel, headed: opt.headed, url, timeoutMs: timeoutSec * 1000, log }, (api) => findRows(api, dbId, { wheres, limit }));
  if (found.hasMore) process.stderr.write(`warning: more rows matched than printed; raise --limit above ${limit}\n`);
  if (opt.json) {
    print(JSON.stringify({ ok: true, id: dbId, title: found.database.title, url: found.database.url, profile: profile.dir, limit, hasMore: found.hasMore, rows: found.rows }));
  } else if (!found.rows.length) {
    process.stderr.write(`warning: no row of "${found.database.title || dbId}" matched\n`);
  } else for (const row of found.rows) print(`${row.url}\t${row.title}`);
  log('Done');
}

try {
  if (opt.help) print(HELP);
  else if (opt.version) print('0.1.0');
  else if (positionals[0] === 'profiles') await profilesCommand();
  else if (positionals[0] === 'find') {
    if (positionals.length > 2) throw new CliError('BAD_INPUT', 'find takes one database URL', 'See notion2md --help', 2);
    await findCommand(positionals[1] ?? '');
  }
  else if (positionals.length === 1) await dumpCommand(positionals[0]);
  else throw new CliError('BAD_INPUT', 'Expected exactly one page URL or id', 'See notion2md --help', 2);
} catch (e) {
  const err = e instanceof CliError ? e : new CliError('ERROR', (e as Error).message, undefined, 1);
  process.stderr.write(`error[${err.code}]: ${err.message}\n${err.hint ? `hint: ${err.hint}\n` : ''}`);
  if (opt.json) print(JSON.stringify({ ok: false, error: { code: err.code, message: err.message, hint: err.hint ?? null } }));
  process.exitCode = err.exit;
}
