import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toMarkdown } from '../src/markdown.ts';
import { apiError, loadTree } from '../src/notion.ts';
import type { Api, ApiResponse, Block } from '../src/types.ts';

const ID = '01234567-89ab-cdef-0123-456789abcdef';
const rec = (b: Record<string, any>) => ({ spaceId: 'sp', value: { value: { alive: true, space_id: 'sp', ...b }, role: 'editor' } });
const recordMap = (...bs: Record<string, any>[]) => ({ block: Object.fromEntries(bs.map((b) => [b.id, rec(b)])) });

const PR = {
  uri: 'https://github.com/swaglive/swag-server/pull/17800',
  attributes: [{ id: 'state', values: ['github:pull_state/merged'] }, { id: 'title', values: ['[GENP-2365] Refactor ingestion'] }],
};

test('markdown: a GitHub pull request link keeps its title and address, as a block, a mention and a relation value', () => {
  const blocks: Record<string, Block> = {
    r: { id: 'r', type: 'page', properties: { title: [['T']] }, content: ['b', 'state', 'm'] },
    b: { id: 'b', type: 'external_object_instance', format: PR },
    state: { id: 'state', type: 'external_object_instance', format: { uri: 'github:pull_state/merged', attributes: [{ id: 'title', values: ['Merged'] }] } },
    m: { id: 'm', type: 'text', properties: { title: [['PR '], ['‣', [['eoi', 'b']]], [' and '], ['‣', [['p', 'page']]]] } },
    page: { id: 'page', type: 'external_object_instance_page', format: { uri: 'https://github.com/swaglive/swag-webapp/pull/1', attributes: [{ id: 'title', values: ['Webapp fix'] }] } },
  };
  assert.equal(
    toMarkdown({ blocks, collections: {} }, 'r'),
    '# T\n\n[[GENP-2365] Refactor ingestion](https://github.com/swaglive/swag-server/pull/17800)\n\nPR [[GENP-2365] Refactor ingestion](https://github.com/swaglive/swag-server/pull/17800) and [Webapp fix](https://github.com/swaglive/swag-webapp/pull/1)\n',
  );
});

test('markdown: a fourth-level heading keeps its heading marker', () => {
  const blocks: Record<string, Block> = {
    r: { id: 'r', type: 'page', properties: { title: [['T']] }, content: ['h'] },
    h: { id: 'h', type: 'header_4', properties: { title: [['4.3.1 Internal API']] } },
  };
  assert.equal(toMarkdown({ blocks, collections: {} }, 'r'), '# T\n\n##### 4.3.1 Internal API\n');
});

test('markdown: row columns that Notion keeps on the block itself are written, with the author by name', () => {
  const blocks: Record<string, Block> = {
    r: { id: 'r', type: 'page', parent_table: 'collection', parent_id: 'c', properties: { title: [['Row']] }, created_time: Date.UTC(2026, 8, 14, 8, 30), last_edited_time: Date.UTC(2026, 8, 15), created_by_id: 'u1', last_edited_by_id: 'u2' },
  };
  const collections = { c: { schema: { title: { name: 'Name', type: 'title' }, a: { name: 'Created', type: 'created_time' }, b: { name: 'Edited', type: 'last_edited_time' }, c: { name: 'By', type: 'created_by' }, d: { name: 'Last by', type: 'last_edited_by' } } } };
  assert.equal(
    toMarkdown({ blocks, collections, users: { u1: 'Lu John' } }, 'r'),
    '# Row\n\n- **Created:** 2026-09-14T08:30:00.000Z\n- **Edited:** 2026-09-15T00:00:00.000Z\n- **By:** @Lu John\n- **Last by:** @user\n',
  );
});

test('loadTree: a synced-block copy brings in the content of the block it points at, and a mention of a link preview is fetched', async () => {
  const synced: string[] = [];
  const api: Api = async (endpoint, body: any) => {
    if (endpoint === 'loadCachedPageChunkV2') {
      const page = { id: ID, type: 'page', properties: { title: [['Root']] }, content: ['ref', 'm'] };
      const ref = { id: 'ref', type: 'transclusion_reference', format: { transclusion_reference_pointer: { id: 'orig' } } };
      const m = { id: 'm', type: 'text', properties: { title: [['‣', [['eoi', 'pr']]]] } };
      return { recordMap: recordMap(page, ref, m), cursors: [{ stack: [] }] };
    }
    const world: Record<string, Record<string, any>> = {
      orig: { id: 'orig', type: 'transclusion_container', content: ['t1'] },
      t1: { id: 't1', type: 'text', properties: { title: [['synced text']] } },
      pr: { id: 'pr', type: 'external_object_instance', format: PR },
    };
    const ids = body.requests.map((r: any) => r.pointer.id);
    synced.push(...ids);
    return { recordMap: recordMap(...ids.map((i: string) => world[i]).filter(Boolean)) };
  };
  const md = toMarkdown(await loadTree(api, ID), ID);
  assert.match(md, /synced text/);
  assert.match(md, /\[\[GENP-2365\] Refactor ingestion\]\(https:\/\/github\.com\/swaglive\/swag-server\/pull\/17800\)/);
  assert.deepEqual([...synced].sort(), ['orig', 'pr', 't1']);
});

test('loadTree: the author of a row can be a bot, which is looked up in the bot table and not in notion_user', async () => {
  const tables: string[] = [];
  const api: Api = async (endpoint, body: any): Promise<ApiResponse> => {
    if (endpoint === 'loadCachedPageChunkV2') {
      const row = { id: ID, type: 'page', parent_table: 'collection', parent_id: 'c', created_by_id: 'u1', created_by_table: 'notion_user', last_edited_by_id: 'bot1', last_edited_by_table: 'bot' };
      return { recordMap: recordMap(row), cursors: [{ stack: [] }] };
    }
    const asked = body.requests.map((r: any) => `${r.pointer.table}:${r.pointer.id}`);
    tables.push(...asked);
    return {
      recordMap: {
        notion_user: asked.includes('notion_user:u1') ? { u1: { value: { value: { id: 'u1', name: 'Lu John' } } } } : {},
        bot: asked.includes('bot:bot1') ? { bot1: { value: { value: { id: 'bot1', name: 'Automation' } } } } : {},
      },
    };
  };
  const store = await loadTree(api, ID);
  assert.deepEqual(tables.filter((t) => !t.startsWith('collection:')).sort(), ['bot:bot1', 'notion_user:u1']);
  assert.deepEqual(store.users, { u1: 'Lu John', bot1: 'Automation' });
});

test('markdown: a block discussion is quoted under its block, a page discussion at the end, and a deleted comment is dropped', () => {
  const blocks: Record<string, Block> = {
    r: { id: 'r', type: 'page', properties: { title: [['T']] }, content: ['p', 'q'], discussions: ['dp'] },
    p: { id: 'p', type: 'text', properties: { title: [['Para']] }, discussions: ['d1'] },
    q: { id: 'q', type: 'text', properties: { title: [['Other']] }, discussions: ['d2'] },
  };
  const discussions: Record<string, any> = {
    d1: { id: 'd1', parent_id: 'p', resolved: true, comments: ['c1', 'c2'] },
    d2: { id: 'd2', parent_id: 'q', resolved: false, comments: ['c3'] },
    dp: { id: 'dp', parent_id: 'r', resolved: false, comments: ['c4'] },
  };
  const comments: Record<string, any> = {
    c1: { id: 'c1', alive: true, text: [['first line\nsecond']], created_by_id: 'u1', created_time: Date.UTC(2026, 8, 14, 8, 30) },
    c2: { id: 'c2', alive: true, text: [['ok']], created_by_id: 'u2', created_time: Date.UTC(2026, 8, 15) },
    c3: { id: 'c3', alive: false, text: [['deleted']], created_by_id: 'u1', created_time: 0 },
    c4: { id: 'c4', alive: true, text: [['page note']], created_by_id: 'u1', created_time: Date.UTC(2026, 8, 16) },
  };
  assert.equal(
    toMarkdown({ blocks, collections: {}, users: { u1: 'Lu John' }, discussions, comments } as any, 'r'),
    '# T\n\nPara\n\n> **@Lu John** (2026-09-14T08:30:00.000Z):\n> first line\n> second\n>\n> **@user** (2026-09-15T00:00:00.000Z):\n> ok\n>\n> _Thread resolved._\n\nOther\n\n> **@Lu John** (2026-09-16T00:00:00.000Z):\n> page note\n',
  );
});

test('loadTree: a discussion the page chunk leaves out is fetched, with its comments, their authors (person or bot) and the people they mention', async () => {
  const requested: string[] = [];
  const api: Api = async (endpoint, body: any): Promise<ApiResponse> => {
    if (endpoint === 'loadCachedPageChunkV2') {
      const page = { id: ID, type: 'page', properties: { title: [['Root']] }, discussions: ['d1'] };
      return { recordMap: recordMap(page), cursors: [{ stack: [] }] };
    }
    const world: Record<string, Record<string, any>> = {
      'discussion:d1': { id: 'd1', parent_id: ID, parent_table: 'block', resolved: false, comments: ['c1', 'c2'] },
      'comment:c1': { id: 'c1', alive: true, text: [['Please check']], created_by_id: 'u1', created_by_table: 'notion_user', created_time: 1 },
      'comment:c2': { id: 'c2', alive: true, text: [['hi '], ['‣', [['u', 'u2']]]], created_by_id: 'b1', created_by_table: 'bot', created_time: 2 },
      'notion_user:u1': { id: 'u1', name: 'Lu John' },
      'notion_user:u2': { id: 'u2', name: 'Anna' },
      'bot:b1': { id: 'b1', name: 'Helper' },
    };
    const asked = body.requests.map((r: any) => `${r.pointer.table}:${r.pointer.id}`);
    requested.push(...asked);
    const out: Record<string, Record<string, any>> = {};
    for (const key of asked.filter((k: string) => world[k])) {
      const [table, id] = key.split(/:(.*)/s);
      (out[table!] ??= {})[id!] = { value: { value: world[key] } };
    }
    return { recordMap: out };
  };
  const store = await loadTree(api, ID);
  assert.deepEqual(requested.filter((t) => !t.startsWith('collection:')).sort(), ['bot:b1', 'comment:c1', 'comment:c2', 'discussion:d1', 'notion_user:u1', 'notion_user:u2']);
  assert.equal(toMarkdown(store, ID), '# Root\n\n> **@Lu John** (1970-01-01T00:00:00.001Z):\n> Please check\n>\n> **@Helper** (1970-01-01T00:00:00.002Z):\n> hi @Anna\n');
});

/** One page that lists `discussions`; every syncRecordValues call goes to `sync`. */
const pageWith = (discussions: string[] | undefined, sync: (body: any) => ApiResponse): Api => async (endpoint, body: any) => {
  if (endpoint !== 'loadCachedPageChunkV2') return sync(body);
  return { recordMap: recordMap({ id: ID, type: 'page', properties: { title: [['Root']] }, discussions }), cursors: [{ stack: [] }] };
};

test('loadTree: a refused comment lookup leaves the page without comments, any other API failure still fails the run', async () => {
  const refused = pageWith(['d1'], () => { throw apiError('syncRecordValues', 403, ''); });
  assert.equal(toMarkdown(await loadTree(refused, ID), ID), '# Root\n');
  const broken = pageWith(['d1'], () => { throw apiError('syncRecordValues', 500, 'boom'); });
  await assert.rejects(loadTree(broken, ID), { code: 'API_ERROR' });
});

test('loadTree: no discussions, an empty list, or an id Notion has no record for add no output, and only the last one costs a request', async () => {
  const asked: string[] = [];
  const answer = (body: any): ApiResponse => {
    asked.push(...body.requests.map((r: any) => r.pointer.table));
    return { recordMap: {} };
  };
  for (const discussions of [undefined, []]) assert.equal(toMarkdown(await loadTree(pageWith(discussions, answer), ID), ID), '# Root\n');
  assert.deepEqual(asked, []);
  assert.equal(toMarkdown(await loadTree(pageWith(['gone'], answer), ID), ID), '# Root\n');
  assert.deepEqual(asked, ['discussion']);
});

test('loadTree: discussions are asked for in batches of 100, so 100 take one request and 101 take two', async () => {
  for (const [count, batches] of [[100, [100]], [101, [100, 1]]] as const) {
    const sizes: number[] = [];
    const ids = Array.from({ length: count }, (_, i) => `d${i}`);
    await loadTree(pageWith(ids, (body) => {
      if (body.requests[0].pointer.table === 'discussion') sizes.push(body.requests.length);
      return { recordMap: {} };
    }), ID);
    assert.deepEqual(sizes, batches, String(count));
  }
});

test('markdown: a comment with no text or time, a missing comment and a missing discussion do not break the page', () => {
  const blocks: Record<string, Block> = {
    r: { id: 'r', type: 'page', properties: { title: [['T']] }, discussions: ['d1', 'd2', 'nope'] },
  };
  const discussions: Record<string, any> = {
    d1: { id: 'd1', comments: ['gone'] },
    d2: { id: 'd2', comments: ['bare'] },
  };
  const comments: Record<string, any> = { bare: { id: 'bare', alive: true, created_by_id: 'u1' } };
  const md = toMarkdown({ blocks, collections: {}, users: { u1: 'Lu John' }, discussions, comments } as any, 'r');
  assert.match(md, /^# T\n\n> \*\*@Lu John\*\*/);
  assert.equal(md.match(/\*\*@/g)?.length, 1);
});
