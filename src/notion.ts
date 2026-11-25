import { existsSync } from 'node:fs';
import { CliError } from './errors.ts';
import { appendEntry, readJournal, slimBlock, slimCollection, startJournal } from './journal.ts';
import type { Api, Block, RecordMap, Store } from './types.ts';

const dashed = (h: string) => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;

const NOTION_HOST = /(^|\.)notion\.(so|com)$|\.notion\.site$/;

// A foreign host would get the real Chrome profile and be trusted for API answers, so refuse it here.
// In a peek view (?p=<id>) the page id is in the query, not the path.
export function parsePageId(input: string): string {
  let s = input.trim();
  let url: URL | undefined;
  try {
    url = new URL(s);
  } catch {
    // not a URL: treat as a bare id
  }
  if (url) {
    if (!/^https?:$/.test(url.protocol) || !NOTION_HOST.test(url.hostname)) {
      throw new CliError('BAD_INPUT', `Not a Notion URL: host "${url.hostname}"`, 'Only notion.so, notion.com and notion.site pages are opened', 2);
    }
    s = url.searchParams.get('p') ?? url.pathname;
  }
  const m = s.replace(/-/g, '').match(/([0-9a-f]{32})\/?$/i);
  if (!m) throw new CliError('BAD_INPUT', `Cannot find a 32-char page id in "${input}"`, 'Pass the page URL or its id', 2);
  return dashed(m[1]!.toLowerCase());
}

/** Page id behind an in-workspace link ("/<id>" or a Notion URL), or undefined for anything else. */
export function linkedPageId(href: string): string | undefined {
  try {
    return parsePageId(href.startsWith('/') ? `https://www.notion.so${href}` : href);
  } catch {
    return undefined;
  }
}

export function apiError(endpoint: string, status: number, text: string): CliError {
  if (status === 429) {
    return new CliError('RATE_LIMITED', `Notion rate limit hit on ${endpoint} (429) and the retries ran out`, 'Wait a minute and run again, or fetch less with a smaller --depth or --max-pages', 1);
  }
  if (status === 401) {
    return new CliError('AUTH_REQUIRED', `Notion does not accept the session behind these cookies (401 on ${endpoint})`, 'Log in to Notion again in that Chrome profile, then run again', 4);
  }
  if ([400, 403, 404].includes(status)) {
    return new CliError('NO_ACCESS', `Notion rejected ${endpoint} (${status})`, 'Check the page id/URL and that this Chrome profile can open the page', 4);
  }
  return new CliError('API_ERROR', `${endpoint} failed (${status}): ${text}`, undefined, 1);
}

/** Delay between API calls: starts at zero, doubles (300 ms up to 3 s) on every 429, halves after 20 calls in a row without one. */
export function createPacer() {
  let delay = 0;
  let streak = 0;
  return {
    get delay() { return delay; },
    slowDown() {
      streak = 0;
      delay = Math.min(delay ? delay * 2 : 300, 3000);
    },
    succeeded() {
      if (delay && ++streak >= 20) {
        streak = 0;
        delay = delay <= 300 ? 0 : delay / 2;
      }
    },
    wait: () => (delay ? new Promise<void>((done) => setTimeout(done, delay)) : Promise.resolve()),
  };
}

export function parseDepth(v: string): number {
  if (v === 'all') return Infinity;
  if (!/^\d+$/.test(v)) throw new CliError('BAD_INPUT', `--depth must be a non-negative integer or "all", got "${v}"`, undefined, 2);
  return Number(v);
}

export function parseMaxPages(v: string | undefined): number {
  if (v === undefined) return 1000;
  if (v === 'all') return Infinity;
  if (!/^[1-9]\d*$/.test(v)) throw new CliError('BAD_INPUT', `--max-pages must be a positive integer or "all", got "${v}"`, undefined, 2);
  return Number(v);
}

export function parseConcurrency(v: string | undefined): number {
  if (v === undefined) return 1;
  if (!/^[1-9]\d*$/.test(v) || Number(v) > 16) throw new CliError('BAD_INPUT', `--concurrency must be a whole number from 1 to 16, got "${v}"`, undefined, 2);
  return Number(v);
}

/** Seconds. Following pages, links and database rows takes minutes, so depth above 0 gets a longer default. */
export function parseTimeout(v: string | undefined, depth: number): number {
  if (v === undefined) return depth > 0 ? 1800 : 90;
  if (!/^\d+(\.\d+)?$/.test(v) || Number(v) <= 0) throw new CliError('BAD_INPUT', `--timeout must be a positive number of seconds, got "${v}"`, undefined, 2);
  return Number(v);
}

// Current shape is {value:{value:block}}, older responses are {value:block}.
const unwrap = (rec: { value?: any } | undefined) => rec?.value?.value ?? rec?.value;

function absorb(store: Store, recordMap: RecordMap = {}): void {
  for (const [id, rec] of Object.entries(recordMap.block ?? {})) {
    const b: Block | undefined = unwrap(rec);
    if (b?.id) {
      store.blocks[id] = b;
      if (store.pending) store.pending.blocks[id] = b;
      store.spaceId ??= rec.spaceId ?? b.space_id;
    }
  }
  for (const [id, rec] of Object.entries(recordMap.collection ?? {})) {
    const c = unwrap(rec);
    if (c) {
      store.collections[id] = c;
      if (store.pending) store.pending.collections[id] = c;
    }
  }
  for (const [id, rec] of Object.entries({ ...recordMap.notion_user, ...recordMap.bot })) {
    const name = unwrap(rec)?.name;
    if (name) store.users[id] = name;
  }
}

const NODE_TYPES = new Set(['page', 'collection_view', 'collection_view_page']);

/** Everything under a page that may need another fetch: unloaded blocks, nested pages/databases, and links to pages. */
function scan(rootId: string, blocks: Store['blocks']) {
  const missing = new Set<string>();
  const nodes: string[] = [];
  const links = new Set<string>();
  const collectLinks = (b: Block) => {
    for (const runs of Object.values(b.properties ?? {})) {
      for (const [, decos] of runs) {
        for (const [tag, arg] of decos ?? []) {
          if (tag === 'p') links.add(arg);
          else if (tag === 'a') {
            const id = linkedPageId(arg);
            if (id) links.add(id);
          }
        }
      }
    }
    if (b.type === 'alias' && b.format?.alias_pointer?.id) links.add(b.format.alias_pointer.id);
  };
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return; // a synced block can point back at a page that contains it
    seen.add(id);
    for (const c of blocks[id]?.content ?? []) {
      const b = blocks[c];
      if (!b) missing.add(c);
      else if (b.alive === false) continue;
      else if (NODE_TYPES.has(b.type)) nodes.push(c);
      else {
        collectLinks(b);
        visit(c);
        const origin = b.type === 'transclusion_reference' ? b.format?.transclusion_reference_pointer?.id : undefined;
        if (origin && blocks[origin]) visit(origin);
        else if (origin) missing.add(origin);
      }
    }
  };
  visit(rootId);
  return { missing, nodes, links };
}

async function sync(api: Api, store: Store, table: string, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += 100) {
    const res = await api('syncRecordValues', {
      requests: ids.slice(i, i + 100).map((id) => ({ pointer: { table, id, spaceId: store.spaceId }, version: -1 })),
    });
    absorb(store, res.recordMap);
  }
}

async function loadPage(api: Api, id: string, store: Store): Promise<void> {
  let cursor: { stack?: unknown[] } | undefined = { stack: [] };
  for (let chunk = 0; ; chunk++) {
    const res = await api('loadCachedPageChunkV2', { page: { id }, limit: 100, cursor, chunkNumber: chunk, verticalColumns: false });
    absorb(store, res.recordMap);
    cursor = res.cursors?.[0] ?? res.cursor;
    if (!cursor?.stack?.length) break;
  }
  // Toggle children and similar lazy blocks are not in the chunks: pull them until nothing is missing.
  for (;;) {
    const missing = [...scan(id, store.blocks).missing].filter((m) => !store.gone.has(m));
    if (!missing.length || !store.spaceId) return;
    await sync(api, store, 'block', missing);
    for (const bid of missing) if (!store.blocks[bid]) store.gone.add(bid);
  }
}

async function resolveMentions(api: Api, store: Store): Promise<void> {
  const ids = new Set<string>();
  const people = new Set<string>();
  const bots = new Set<string>();
  for (const b of Object.values(store.blocks)) {
    for (const runs of Object.values(b.properties ?? {})) {
      for (const [, decos] of runs) {
        for (const [tag, arg] of decos ?? []) {
          if ((tag === 'p' || tag === 'eoi') && !store.blocks[arg]) ids.add(arg);
          else if (tag === 'u' && !store.users[arg]) people.add(arg);
        }
      }
    }
    if (b.parent_table === 'collection') {
      for (const [u, table] of [[b.created_by_id, b.created_by_table], [b.last_edited_by_id, b.last_edited_by_table]]) {
        if (u && !store.users[u]) (table === 'bot' ? bots : people).add(u);
      }
    }
  }
  if (!store.spaceId) return;
  await sync(api, store, 'block', [...ids]);
  await sync(api, store, 'notion_user', [...people]);
  await sync(api, store, 'bot', [...bots]);
  // A mentioned database has no title of its own, its name lives in the collection record.
  const collections = [...ids].map((id) => store.blocks[id]?.collection_id).filter((c): c is string => !!c && !store.collections[c]);
  await sync(api, store, 'collection', collections);
}

export function newStore(): Store {
  return {
    blocks: {}, collections: {}, users: {}, expanded: new Set(), children: new Map(), rows: new Map(), spaceId: undefined,
    gone: new Set(), noAccess: new Map(), skipped: [], truncated: undefined, error: undefined,
  };
}

// shortcut: first 5000 rows of a database only, page with a higher limit if one ever needs more
async function loadRows(api: Api, store: Store, db: Block): Promise<string[]> {
  const view = db.view_ids?.[0];
  if (!db.collection_id || !view) return [];
  const space = store.spaceId;
  const res = await api('queryCollection', {
    collection: { id: db.collection_id, spaceId: space },
    collectionView: { id: view, spaceId: space },
    source: { type: 'collection', id: db.collection_id, spaceId: space },
    loader: { type: 'reducer', reducers: { collection_group_results: { type: 'results', limit: 5000 } }, sort: [], searchQuery: '', userTimeZone: 'UTC' },
  });
  absorb(store, res.recordMap);
  const ids = (res.result?.reducerResults?.collection_group_results?.blockIds ?? []).filter((id) => store.blocks[id]?.alive !== false);
  store.rows.set(db.id, ids);
  return ids;
}

export interface LoadOptions {
  /** Hops to follow from the root: nested pages, linked pages, databases, and a database's rows each count as one. */
  depth?: number;
  maxPages?: number;
  /** Pages fetched at the same time (default 1). */
  concurrency?: number;
  /** File that each finished page is appended to. With `resume`, an existing one is replayed first, so those pages are not fetched again. */
  journal?: string;
  resume?: boolean;
  /** Stops before the next page is fetched, keeping what was loaded. */
  signal?: AbortSignal;
  onPage?: (id: string, store: Store, level: number) => void;
}

// A refused page (or batch of links) is recorded by the caller as "no access", any other failure is a real error.
async function orNoAccess(work: Promise<void>): Promise<void> {
  try {
    await work;
  } catch (e) {
    if (!(e instanceof CliError && e.code === 'NO_ACCESS')) throw e;
  }
}

/** Rebuilds the store and the list of pages still to fetch from a journal written by an earlier run. */
function replay(path: string, rootId: string, store: Store, queue: [string, number][], queued: Set<string>, cameFrom: Map<string, string>): void {
  const [head, ...entries] = readJournal(path);
  if (head?.root !== rootId) throw new CliError('BAD_INPUT', `${path} belongs to a crawl of another page`, 'Delete it, or resume with the page it was started from', 2);
  for (const e of entries) {
    store.spaceId ??= e.spaceId;
    Object.assign(store.blocks, e.blocks);
    Object.assign(store.collections, e.collections);
    if (e.done) {
      store.expanded.add(e.done);
      if (e.rows) store.rows.set(e.done, e.rows);
      if (e.children) store.children.set(e.done, e.children);
    }
    for (const [id, level, from] of e.queued ?? []) {
      if (queued.has(id)) continue;
      queued.add(id);
      cameFrom.set(id, from);
      queue.push([id, level]);
    }
    for (const [id, from] of e.refused ?? []) store.noAccess.set(id, from);
  }
  const left = queue.filter(([id]) => !store.expanded.has(id) && !store.noAccess.has(id));
  queue.splice(0, queue.length, ...left);
}

export async function loadTree(api: Api, rootId: string, opts: LoadOptions = {}): Promise<Store> {
  const { depth = 0, maxPages = Infinity, concurrency = 1, journal, resume, signal, onPage } = opts;
  const store = newStore();
  const queue: [string, number][] = [[rootId, 0]];
  const queued = new Set([rootId]);
  const cameFrom = new Map<string, string>();
  if (journal) {
    if (resume && existsSync(journal)) replay(journal, rootId, store, queue, queued, cameFrom);
    else startJournal(journal, rootId);
    store.pending = { blocks: {}, collections: {} };
  }
  // Records already in the journal, by version: Notion hands the same row back on every fetch that mentions it.
  const written = new Map<string, number | undefined>();
  for (const [id, r] of [...Object.entries(store.blocks), ...Object.entries(store.collections)]) written.set(id, r.version);
  const fresh = <T extends { version?: number }>(records: Record<string, T>, slim: (r: T) => T) => {
    const out: Record<string, T> = {};
    for (const [id, r] of Object.entries(records)) {
      if (r.version !== undefined && written.get(id) === r.version) continue;
      written.set(id, r.version);
      out[id] = slim(r);
    }
    return out;
  };
  if (!store.blocks[rootId]) {
    await loadPage(api, rootId, store);
    if (!store.blocks[rootId]) {
      throw new CliError('NO_ACCESS', `Page ${rootId} not returned by Notion`, 'The page is private to another account, deleted, or the session behind the cookies is no longer valid', 4);
    }
  }
  const expandNode = async (id: string, level: number) => {
    const block = store.blocks[id]!;
    if (block.type === 'page' && id !== rootId) await loadPage(api, id, store);
    if (block.parent_table === 'collection' && block.parent_id && !store.collections[block.parent_id]) {
      await sync(api, store, 'collection', [block.parent_id]);
    }
    // `inside` is what the page contains (nested pages, databases, rows) and decides the folder layout,
    // `links` is what it points at and is only fetched.
    let inside: string[];
    let links: string[] = [];
    if (block.type === 'page') {
      const found = scan(id, store.blocks);
      inside = found.nodes;
      links = [...found.links].filter((f) => f !== id);
    } else {
      inside = await loadRows(api, store, block);
    }
    store.expanded.add(id);
    onPage?.(id, store, level);

    const queuedNow: [string, number, string][] = [];
    const refusedNow: [string, string][] = [];
    if (level < depth) {
      const all = [...new Set([...inside, ...links])];
      const unknown = all.filter((f) => !store.blocks[f] && !store.gone.has(f));
      if (unknown.length && store.spaceId) await orNoAccess(sync(api, store, 'block', unknown));
      for (const f of unknown) if (!store.blocks[f]) store.gone.add(f);
      const reachable = (f: string) => {
        const target = store.blocks[f];
        if (!target) {
          store.noAccess.set(f, id);
          refusedNow.push([f, id]);
        }
        return !!target && NODE_TYPES.has(target.type) && target.alive !== false;
      };
      const kept = all.filter(reachable);
      store.children.set(id, inside.filter((f) => kept.includes(f)));
      for (const f of kept) {
        if (queued.has(f)) continue;
        queued.add(f);
        cameFrom.set(f, id);
        queue.push([f, level + 1]);
        queuedNow.push([f, level + 1, id]);
      }
    }
    if (journal) {
      const { blocks, collections } = store.pending!;
      appendEntry(journal, { done: id, spaceId: store.spaceId, blocks: fresh(blocks, slimBlock), collections: fresh(collections, slimCollection), rows: store.rows.get(id), children: store.children.get(id), queued: queuedNow, refused: refusedNow });
      store.pending = { blocks: {}, collections: {} };
    }
  };

  let inflight = 0;
  let halted = false;
  const tick = () => new Promise<void>((done) => setTimeout(done, 5));
  const worker = async () => {
    while (!halted) {
      if (signal?.aborted && store.expanded.size) { store.truncated = 'aborted'; halted = true; break; }
      if (!queue.length) {
        if (!inflight) break;
        await tick(); // a page still being fetched may add more to the queue
        continue;
      }
      if (store.expanded.size + inflight >= maxPages) {
        if (!inflight) { store.truncated = 'max-pages'; halted = true; break; }
        await tick();
        continue;
      }
      const [id, level] = queue.shift()!;
      inflight++;
      try {
        await expandNode(id, level);
      } catch (e) {
        if (!(e instanceof CliError)) throw e;
        if (e.code === 'NO_ACCESS' && !store.expanded.has(id)) {
          const from = cameFrom.get(id) ?? rootId;
          store.noAccess.set(id, from);
          if (journal) appendEntry(journal, { refused: [[id, from]] });
          continue;
        }
        // Any other failure must not throw away the pages already fetched, so stop here and keep them.
        store.truncated = 'error';
        store.error = e.message;
        if (!store.expanded.has(id)) queue.unshift([id, level]);
        halted = true;
      } finally {
        inflight--;
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  store.skipped = queue.map(([id]) => id);
  store.pending = undefined;
  await orNoAccess(resolveMentions(api, store));
  return store;
}
