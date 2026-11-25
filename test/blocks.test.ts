import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toMarkdown } from '../src/markdown.ts';
import { loadTree } from '../src/notion.ts';
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
