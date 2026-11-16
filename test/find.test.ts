import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFilter, findRows, parseLimit, parseWheres, type Schema } from '../src/find.ts';
import type { Api, ApiResponse } from '../src/types.ts';

const ID = '0123456789abcdef0123456789abcdef';
const ROW = 'fedcba9876543210fedcba9876543210';

const schema: Schema = {
  title: { name: 'Task name', type: 'title' },
  'E>`Y': { name: 'Target Version', type: 'text' },
  'notion://tasks/auto_increment_id_property': { name: 'Task ID', type: 'auto_increment_id' },
  'notion://tasks/status_property': { name: 'Status', type: 'status', options: [{ value: '🗄 Backlog' }, { value: '✅ Done' }] },
  'notion://tasks/priority_property': { name: 'Priority', type: 'select', options: [{ value: '🧀 Medium' }] },
  '?cg<': { name: 'Teams', type: 'multi_select', options: [{ value: 'Backend' }] },
  'OFW\\': { name: 'BE Expected Delivery Date', type: 'date' },
};

test('parseWheres splits on the first "=" and keeps the rest of the value', () => {
  assert.deepEqual(parseWheres(['Task ID=6660']), [{ name: 'Task ID', value: '6660' }]);
  assert.deepEqual(parseWheres(['Note=a=b']), [{ name: 'Note', value: 'a=b' }]);
  assert.deepEqual(parseWheres([' Status = Done ']), [{ name: 'Status', value: 'Done' }]);
  assert.throws(() => parseWheres(['6660']), /--where must look like "Name=value"/);
  assert.throws(() => parseWheres(['=6660']), /--where must look like "Name=value"/);
});

test('parseLimit defaults to 20 and refuses anything but a positive integer', () => {
  assert.equal(parseLimit(undefined), 20);
  assert.equal(parseLimit('5'), 5);
  for (const bad of ['0', '-1', 'x', '1.5']) assert.throws(() => parseLimit(bad), /--limit must be a positive integer/);
});

test('buildFilter turns a name and a value into the operator its property type needs', () => {
  const filter = (where: string) => buildFilter(schema, parseWheres([where]));
  assert.deepEqual(filter('Target Version=v3'), { operator: 'and', filters: [{ property: 'E>`Y', filter: { operator: 'string_contains', value: { type: 'exact', value: 'v3' } } }] });
  assert.deepEqual(filter('Task ID=6660').filters, [{ property: 'notion://tasks/auto_increment_id_property', filter: { operator: 'number_equals', value: { type: 'exact', value: 6660 } } }]);
  assert.deepEqual(filter('Status=🗄 Backlog').filters, [{ property: 'notion://tasks/status_property', filter: { operator: 'status_is', value: { type: 'is_option', value: '🗄 Backlog' } } }]);
  assert.deepEqual(filter('Priority=🧀 medium').filters, [{ property: 'notion://tasks/priority_property', filter: { operator: 'enum_is', value: { type: 'exact', value: '🧀 Medium' } } }]);
  assert.deepEqual(filter('Teams=Backend').filters, [{ property: '?cg<', filter: { operator: 'enum_contains', value: { type: 'exact', value: 'Backend' } } }]);
  assert.equal(buildFilter(schema, parseWheres(['Task ID=1', 'Status=✅ Done'])).operator, 'and');
  assert.equal(buildFilter(schema, parseWheres(['Task ID=1', 'Status=✅ Done'])).filters.length, 2);
});

test('buildFilter names the property or the options instead of matching nothing', () => {
  assert.throws(() => buildFilter(schema, parseWheres(['Nope=1'])), /has no property named "Nope"/);
  assert.throws(() => buildFilter(schema, parseWheres(['Status=Nope'])), /"Nope" is not an option of the "Status" property/);
  assert.throws(() => buildFilter(schema, parseWheres(['Task ID=abc'])), /"Task ID" property holds numbers/);
  assert.throws(() => buildFilter(schema, parseWheres(['BE Expected Delivery Date=2026-01-01'])), /Cannot look up the date property/);
});

function fakeApi(over: { isPage?: boolean; hasMore?: boolean; dead?: boolean; missingBlock?: boolean; noSpace?: boolean; noCollection?: boolean; noSchema?: boolean; noRows?: boolean } = {}) {
  const calls: { endpoint: string; body: any }[] = [];
  const api: Api = async (endpoint, body: any): Promise<ApiResponse> => {
    calls.push({ endpoint, body });
    if (endpoint === 'loadCachedPageChunkV2') {
      if (over.missingBlock) return { recordMap: { block: {} } };
      const spaceId = over.noSpace ? undefined : 'space-1';
      return {
        recordMap: {
          block: {
            [ID]: {
              spaceId,
              value: { value: { id: ID, type: over.isPage ? 'page' : 'collection_view_page', collection_id: over.isPage ? undefined : 'coll-1', view_ids: over.isPage ? undefined : ['view-1'], space_id: spaceId, properties: { title: [['DB Board']] } } },
            },
          },
          collection: over.noCollection ? {} : { 'coll-1': { value: { value: { name: [['Tasks']], schema: over.noSchema ? undefined : schema } } } },
        },
      };
    }
    const rows = over.noRows ? [] : [ROW];
    return {
      recordMap: {
        block: rows.length
          ? { [ROW]: { value: { value: { id: ROW, alive: !over.dead, parent_table: 'collection', properties: { title: [['GENP-6660']] } } } } }
          : {},
      },
      result: { reducerResults: { collection_group_results: { blockIds: rows, hasMore: over.hasMore ?? false } } },
    };
  };
  return { api, calls };
}

test('findRows asks Notion for the filtered rows and names them', async () => {
  const { api, calls } = fakeApi();
  const found = await findRows(api, ID, { wheres: parseWheres(['Task ID=6660']), limit: 10 });
  assert.deepEqual(found.database, { id: ID, title: 'DB Board', url: `https://www.notion.so/${ID}` });
  assert.deepEqual(found.rows, [{ id: ROW, title: 'GENP-6660', url: `https://www.notion.so/${ROW}` }]);
  assert.equal(found.hasMore, false);
  const query = calls.find((c) => c.endpoint === 'queryCollection')!;
  assert.equal(query.body.collection.id, 'coll-1');
  assert.equal(query.body.collectionView.id, 'view-1');
  assert.deepEqual(query.body.loader.reducers.collection_group_results.filter.filters[0].filter, { operator: 'number_equals', value: { type: 'exact', value: 6660 } });
  assert.equal(query.body.loader.reducers.collection_group_results.limit, 10);
  assert.equal(calls[0]!.body.page.id, ID);
});

test('findRows reports more matches and skips deleted rows', async () => {
  assert.equal((await findRows(fakeApi({ hasMore: true }).api, ID, { wheres: parseWheres(['Task ID=1']), limit: 1 })).hasMore, true);
  assert.deepEqual((await findRows(fakeApi({ dead: true }).api, ID, { wheres: parseWheres(['Task ID=1']), limit: 1 })).rows, []);
});

test('findRows refuses a page instead of a database', async () => {
  await assert.rejects(findRows(fakeApi({ isPage: true }).api, ID, { wheres: parseWheres(['Task ID=1']), limit: 1 }), /is a page, not a database/);
});

test('findRows reports NO_ACCESS when Notion returns no page, and API_ERROR when the answer is incomplete', async () => {
  const code = async (over: Parameters<typeof fakeApi>[0]) => {
    try {
      await findRows(fakeApi(over).api, ID, { wheres: parseWheres(['Task ID=1']), limit: 1 });
      return 'none';
    } catch (e) {
      return (e as { code?: string }).code;
    }
  };
  assert.equal(await code({ missingBlock: true }), 'NO_ACCESS');
  assert.equal(await code({ noSpace: true }), 'API_ERROR');
  assert.equal(await code({ noCollection: true }), 'API_ERROR');
  assert.equal(await code({ noSchema: true }), 'API_ERROR');
});

test('findRows answers with an empty list when nothing matches', async () => {
  const found = await findRows(fakeApi({ noRows: true }).api, ID, { wheres: parseWheres(['Task ID=1']), limit: 5 });
  assert.deepEqual(found.rows, []);
  assert.equal(found.hasMore, false);
  assert.equal(found.database.title, 'DB Board');
});

test('an empty --where list or empty strings are refused instead of matching everything', () => {
  assert.deepEqual(parseWheres([]), []);
  assert.throws(() => parseWheres(['']), /--where must look like "Name=value"/);
  assert.throws(() => parseWheres(['=']), /--where must look like "Name=value"/);
  assert.throws(() => parseLimit(''), /--limit must be a positive integer/);
  assert.throws(() => buildFilter({}, parseWheres(['Task ID=1'])), /has no property named "Task ID"/);
});
