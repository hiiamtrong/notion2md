import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiError, loadTree } from '../src/notion.ts';
import { JOURNAL_FILE, readJournal } from '../src/journal.ts';
import type { Api } from '../src/types.ts';

const ROOT = '01234567-89ab-cdef-0123-456789abcdef';
const rec = (b: Record<string, any>) => ({ spaceId: 'sp', value: { value: { alive: true, space_id: 'sp', version: 1, crdt_data: 'x'.repeat(500), permissions: [{ role: 'editor' }], ...b }, role: 'editor' } });

/** root -> a, b, c; a -> a1; b -> b1. Every page fetch is logged, and `refuse` pages answer 403. */
function world(tree: Record<string, string[]>, refuse: string[] = []) {
  const fetched: string[] = [];
  const page = (id: string) => ({ id, type: 'page', content: tree[id] ?? [], properties: { title: [[id]] } });
  const api: Api = async (endpoint, body: any) => {
    if (endpoint !== 'loadCachedPageChunkV2') {
      const all = (body.requests ?? []).map((r: any) => r.pointer.id).filter((id: string) => id === ROOT || id in tree || Object.values(tree).some((c) => c.includes(id)));
      return { recordMap: { block: Object.fromEntries(all.map((id: string) => [id, rec(page(id))])) } };
    }
    const id: string = body.page.id;
    fetched.push(id);
    if (refuse.includes(id)) throw apiError('loadCachedPageChunkV2', 403, '');
    return { recordMap: { block: Object.fromEntries([id, ...(tree[id] ?? [])].map((x) => [x, rec(page(x))])) }, cursors: [{ stack: [] }] };
  };
  return { api, fetched };
}

const TREE = { [ROOT]: ['a', 'b', 'c'], a: ['a1'], b: ['b1'] };
const tmp = () => join(mkdtempSync(join(tmpdir(), 'notion2md-resume-')), JOURNAL_FILE);
const cleanup = (file: string) => rmSync(join(file, '..'), { recursive: true });

test('resume: a stopped crawl continues without fetching pages again, and ignores a line cut short by a kill', async () => {
  const journal = tmp();
  try {
    const first = world(TREE);
    const stopped = await loadTree(first.api, ROOT, { depth: 9, maxPages: 3, journal });
    assert.equal(stopped.truncated, 'max-pages');
    assert.deepEqual(first.fetched, [ROOT, 'a', 'b']);

    appendFileSync(journal, '{"done":"c","blocks":{"c":{"id"');
    const second = world(TREE);
    const store = await loadTree(second.api, ROOT, { depth: 9, journal, resume: true });
    assert.deepEqual(second.fetched, ['c', 'a1', 'b1']);
    assert.equal(store.truncated, undefined);
    assert.deepEqual([...store.expanded].sort(), [ROOT, 'a', 'a1', 'b', 'b1', 'c'].sort());
    assert.equal(store.skipped.length, 0);
  } finally {
    cleanup(journal);
  }
});

test('resume: a refused page stays refused without being asked for again', async () => {
  const journal = tmp();
  try {
    await loadTree(world(TREE, ['c']).api, ROOT, { depth: 9, journal });
    const again = world(TREE, ['c']);
    const store = await loadTree(again.api, ROOT, { depth: 9, journal, resume: true });
    assert.deepEqual(again.fetched, []);
    assert.deepEqual([...store.noAccess], [['c', ROOT]]);
  } finally {
    cleanup(journal);
  }
});

test('resume: without --resume an old journal is replaced, and a journal of another page is refused', async () => {
  const journal = tmp();
  try {
    await loadTree(world(TREE).api, ROOT, { depth: 9, journal });
    const fresh = world(TREE);
    await loadTree(fresh.api, ROOT, { depth: 9, journal });
    assert.equal(fresh.fetched.length, 6, 'everything is fetched again');
    await assert.rejects(loadTree(world({ x: [] }).api, 'x', { depth: 9, journal, resume: true }), { code: 'BAD_INPUT' });
  } finally {
    cleanup(journal);
  }
});

test('journal: keeps only the fields the tool reads, and each record once', async () => {
  const journal = tmp();
  try {
    await loadTree(world(TREE).api, ROOT, { depth: 9, journal });
    assert.doesNotMatch(readFileSync(journal, 'utf8'), /crdt_data|permissions/);
    const ids = readJournal(journal).flatMap((e) => Object.keys(e.blocks ?? {}));
    assert.equal(ids.length, new Set(ids).size, ids.join(','));
  } finally {
    cleanup(journal);
  }
});

test('concurrency: the same pages are fetched, and max-pages still stops at exactly that many', async () => {
  const tree: Record<string, string[]> = { [ROOT]: Array.from({ length: 20 }, (_, i) => `p${i}`) };
  const all = await loadTree(world(tree).api, ROOT, { depth: 9, concurrency: 4 });
  assert.equal(all.expanded.size, 21);
  const capped = await loadTree(world(tree).api, ROOT, { depth: 9, concurrency: 4, maxPages: 7 });
  assert.equal(capped.expanded.size, 7);
  assert.equal(capped.truncated, 'max-pages');
  assert.equal(capped.skipped.length, 14);
});
