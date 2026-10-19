import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toMarkdown } from '../src/markdown.ts';
import { apiError, createPacer, linkedPageId, loadTree, newStore, parseDepth, parseMaxPages, parsePageId, parseTimeout } from '../src/notion.ts';
import { layout, slug, writeTree } from '../src/tree.ts';
import { CliError } from '../src/errors.ts';
import type { Api, Block } from '../src/types.ts';

const ID = '01234567-89ab-cdef-0123-456789abcdef';
const rec = (b: Record<string, any>) => ({ spaceId: 'sp', value: { value: { alive: true, ...b }, role: 'editor' } });
const recordMap = (...bs: Record<string, any>[]) => ({ block: Object.fromEntries(bs.map((b) => [b.id, rec(b)])) });

test('parsePageId handles every URL shape', () => {
  for (const input of [
    'https://app.notion.com/p/acme/Knowledge-Map-0123456789abcdef0123456789abcdef',
    'https://www.notion.so/team/Page-0123456789abcdef0123456789abcdef?pvs=4#frag',
    'https://x.notion.so/db?v=1&p=0123456789abcdef0123456789abcdef&pm=s',
    '0123456789abcdef0123456789abcdef',
    ID,
  ]) assert.equal(parsePageId(input), ID, input);
  assert.throws(() => parsePageId('hello'), { code: 'BAD_INPUT' });
});

test('markdown: inline styles, lists, code fence, table, callout', () => {
  const blocks: Record<string, Block> = {
    r: { id: 'r', type: 'page', properties: { title: [['Doc']] }, content: ['h', 'p', 'n1', 'n2', 'b', 'c', 't', 'q'] },
    h: { id: 'h', type: 'sub_header', properties: { title: [['Head']] } },
    p: { id: 'p', type: 'text', properties: { title: [['bold ', [['b']]], ['x', [['c']]], [' ', []], ['site', [['a', 'https://e.com']]]] } },
    n1: { id: 'n1', type: 'numbered_list', properties: { title: [['one']] } },
    n2: { id: 'n2', type: 'numbered_list', properties: { title: [['two']] } },
    b: { id: 'b', type: 'to_do', properties: { title: [['task']], checked: [['Yes']] }, content: ['bc'] },
    bc: { id: 'bc', type: 'text', properties: { title: [['nested']] } },
    c: { id: 'c', type: 'code', properties: { title: [['a ```b``` c']], language: [['JavaScript']] } },
    t: { id: 't', type: 'table', format: { table_block_column_order: ['a', 'b'], table_block_column_header: true }, content: ['r1', 'r2'] },
    r1: { id: 'r1', type: 'table_row', properties: { a: [['H1']], b: [['H2']] } },
    r2: { id: 'r2', type: 'table_row', properties: { a: [['x|y']], b: [['z']] } },
    q: { id: 'q', type: 'callout', format: { page_icon: '💡' }, properties: { title: [['note']] } },
  };
  const md = toMarkdown({ blocks, collections: {} }, 'r');
  assert.equal(md, `# Doc

### Head

**bold** \`x\` [site](https://e.com)

1. one
2. two
- [x] task

    nested

\`\`\`\`javascript
a \`\`\`b\`\`\` c
\`\`\`\`

| H1 | H2 |
| --- | --- |
| x\\|y | z |

> 💡 note
`);
});

function fakeNotion() {
  const calls: [string, unknown][] = [];
  const root = { id: ID, type: 'page', space_id: 'sp', properties: { title: [['Root']] }, content: ['tg', 'child'] };
  const tg = { id: 'tg', type: 'toggle', properties: { title: [['T']] }, content: ['hidden'] };
  const child = { id: 'child', type: 'page', properties: { title: [['Sub']] }, content: ['cc'] };
  const hidden = { id: 'hidden', type: 'text', properties: { title: [['inside toggle']] } };
  const cc = { id: 'cc', type: 'text', properties: { title: [['child body']] } };
  const api: Api = async (endpoint, body: any) => {
    calls.push([endpoint, body.page?.id ?? body.requests?.map((r: any) => r.pointer.id)]);
    if (endpoint === 'loadCachedPageChunkV2') {
      if (body.page.id === ID) {
        // two chunks: the second one only arrives because the first returned a cursor
        return body.chunkNumber === 0
          ? { recordMap: recordMap(root, tg), cursors: [{ stack: [['x']] }] }
          : { recordMap: recordMap(child), cursors: [{ stack: [] }] };
      }
      return { recordMap: recordMap(child, cc), cursors: [{ stack: [] }] };
    }
    const all: Record<string, Record<string, any>> = { hidden, cc };
    return { recordMap: recordMap(...body.requests.map((r: any) => all[r.pointer.id]).filter(Boolean)) };
  };
  return { api, calls };
}

test('loadTree: paginates, pulls lazy toggle children, leaves child pages alone at depth 0', async () => {
  const { api, calls } = fakeNotion();
  const store = await loadTree(api, ID, { depth: 0 });
  const md = toMarkdown(store, ID);
  assert.match(md, /- T\n\n    inside toggle/);
  assert.match(md, /\[Sub\]\(https:\/\/www\.notion\.so\/child\)/);
  assert.doesNotMatch(md, /child body/);
  assert.equal(calls.filter(([e]) => e === 'loadCachedPageChunkV2').length, 2);
});

test('loadTree: missing root means no access', async () => {
  await assert.rejects(loadTree(async () => ({ recordMap: {} }), ID), { code: 'NO_ACCESS', exit: 4 });
});

// --- empty / missing / boundary cases ---

const doc = (...rest: Block[]) => {
  const blocks: Record<string, Block> = { r: { id: 'r', type: 'page', properties: { title: [['T']] }, content: rest.map((b) => b.id) } };
  for (const b of rest) blocks[b.id] = b;
  return toMarkdown({ blocks, collections: {} }, 'r');
};

test('parsePageId: empty, blank and one char short are rejected, exactly 32 is accepted', () => {
  for (const bad of ['', '   ', 'a'.repeat(31)]) assert.throws(() => parsePageId(bad), { code: 'BAD_INPUT' });
  assert.equal(parsePageId('a'.repeat(32)), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
});

test('markdown: a page with no title, no properties and no content renders an empty heading', () => {
  const md = toMarkdown({ blocks: { r: { id: 'r', type: 'page' } }, collections: {} }, 'r');
  assert.equal(md, '#\n');
});

test('markdown: dangling child ids and deleted blocks are skipped without throwing', () => {
  const md = toMarkdown({
    blocks: {
      r: { id: 'r', type: 'page', properties: { title: [['T']] }, content: ['ghost', 'dead', 'kept'] },
      dead: { id: 'dead', type: 'text', alive: false, properties: { title: [['gone']] } },
      kept: { id: 'kept', type: 'text', properties: { title: [['kept']] } },
    },
    collections: {},
  }, 'r');
  assert.equal(md, '# T\n\nkept\n');
});

test('markdown: blocks missing their payload render nothing instead of "undefined"', () => {
  const md = doc(
    { id: 'tbl', type: 'table', format: { table_block_column_order: ['a'] } },
    { id: 'img', type: 'image' },
    { id: 'bm', type: 'bookmark' },
    { id: 'al', type: 'alias' },
  );
  assert.equal(md, '# T\n');
});

test('markdown: table with only a header row keeps header and separator, short rows pad empty cells', () => {
  const blocks: Record<string, Block> = {
    r: { id: 'r', type: 'page', properties: { title: [['T']] }, content: ['t'] },
    t: { id: 't', type: 'table', format: { table_block_column_order: ['a', 'b'], table_block_column_header: true }, content: ['r1'] },
    r1: { id: 'r1', type: 'table_row', properties: { a: [['H']] } },
  };
  assert.equal(toMarkdown({ blocks, collections: {} }, 'r'), '# T\n\n| H |  |\n| --- | --- |\n');
});

test('markdown: code fence grows only past a run of 3 backticks', () => {
  const fence = (code: string) => doc({ id: 'c', type: 'code', properties: { title: [[code]] } }).split('\n')[2];
  assert.equal(fence('a `` b'), '```');
  assert.equal(fence('a ``` b'), '````');
  assert.equal(doc({ id: 'c', type: 'code' }), '# T\n\n```\n\n```\n');
});

test('markdown: a numbered list interrupted by another block restarts at 1', () => {
  const md = doc(
    { id: 'a', type: 'numbered_list', properties: { title: [['x']] } },
    { id: 'p', type: 'text', properties: { title: [['p']] } },
    { id: 'b', type: 'numbered_list', properties: { title: [['y']] } },
  );
  assert.equal(md, '# T\n\n1. x\n\np\n\n1. y\n');
});

test('markdown: empty runs, undecorated runs and unknown mentions do not break inline text', () => {
  const md = doc({ id: 't', type: 'text', properties: { title: [['plain'], ['‣', [['p', 'zz']]], ['', [['b']]]] } });
  assert.equal(md, '# T\n\nplain[page](https://www.notion.so/zz)\n');
});

const withHiddenKids = (n: number) => {
  const calls: unknown[] = [];
  const kids = Array.from({ length: n }, (_, i) => `k${i}`);
  const api: Api = async (endpoint, body: any) => {
    calls.push(endpoint === 'syncRecordValues' ? body.requests.length : endpoint);
    return endpoint === 'loadCachedPageChunkV2'
      ? { recordMap: recordMap({ id: ID, type: 'page', space_id: 'sp', content: kids }) }
      : { recordMap: recordMap(...body.requests.map((r: any) => ({ id: r.pointer.id, type: 'text' }))) };
  };
  return { api, calls };
};

test('loadTree: lazy children are fetched in batches of 100, 100 is one call and 101 is two', async () => {
  for (const [n, batches] of [[100, [100]], [101, [100, 1]]] as [number, number[]][]) {
    const { api, calls } = withHiddenKids(n);
    await loadTree(api, ID);
    assert.deepEqual(calls, ['loadCachedPageChunkV2', ...batches], `n=${n}`);
  }
});

test('loadTree: a child Notion never returns does not loop forever', async () => {
  const calls: unknown[] = [];
  const api: Api = async (endpoint) => {
    calls.push(endpoint);
    return endpoint === 'loadCachedPageChunkV2'
      ? { recordMap: recordMap({ id: ID, type: 'page', space_id: 'sp', content: ['ghost'] }) }
      : { recordMap: {} };
  };
  const md = toMarkdown(await loadTree(api, ID), ID);
  assert.deepEqual(calls, ['loadCachedPageChunkV2', 'syncRecordValues']);
  assert.equal(md, '#\n');
});

test('loadTree: response without recordMap means no access, and a bare page makes no extra calls', async () => {
  await assert.rejects(loadTree(async () => ({}), ID), { code: 'NO_ACCESS' });
  const calls: unknown[] = [];
  await loadTree(async (endpoint: string) => {
    calls.push(endpoint);
    return { recordMap: recordMap({ id: ID, type: 'page', space_id: 'sp' }) };
  }, ID);
  assert.deepEqual(calls, ['loadCachedPageChunkV2']);
});

test('loadTree: depth 1 expands children but not grandchildren', async () => {
  const pages: Record<string, Record<string, any>[]> = {
    [ID]: [{ id: ID, type: 'page', space_id: 'sp', content: ['c1'] }, { id: 'c1', type: 'page', content: ['gc'] }],
    c1: [{ id: 'c1', type: 'page', content: ['gc'] }, { id: 'gc', type: 'page', content: ['deep'] }],
  };
  const api: Api = async (endpoint, body: any) => (endpoint === 'loadCachedPageChunkV2'
    ? { recordMap: recordMap(...pages[body.page.id]) }
    : { recordMap: {} });
  const store = await loadTree(api, ID, { depth: 1 });
  assert.deepEqual([...store.expanded], [ID, 'c1']);
});

// --- folder output ---

test('parseDepth: "all" is unlimited, junk is rejected', () => {
  assert.equal(parseDepth('all'), Infinity);
  assert.equal(parseDepth('0'), 0);
  assert.equal(parseDepth('3'), 3);
  for (const bad of ['', '-1', '1.5', 'abc', 'ALL']) assert.throws(() => parseDepth(bad), { code: 'BAD_INPUT', exit: 2 }, bad);
});

test('slug: keeps titles inside the output dir and never empty', () => {
  assert.equal(slug('a/b\\c:d'), 'a-b-c-d');
  assert.equal(slug('../../etc/passwd'), '-..-etc-passwd');
  for (const bad of ['', '   ', '..', '.', '...hidden.', '\u0001']) assert.doesNotMatch(slug(bad), /^\.|\/|\.$|^$/, JSON.stringify(bad));
  assert.equal(slug('..'), 'Untitled');
  assert.equal(slug('Trang Việt'), 'Trang Việt');
  assert.equal(slug('x'.repeat(80)).length, 80);
  assert.equal(slug('x'.repeat(81)).length, 80);
});

function treeStore() {
  const page = (id: string, title: string, content: string[] = []): Block => ({ id, type: 'page', properties: { title: [[title]] }, content });
  const blocks: Record<string, Block> = {
    root: page('root', 'Root', ['a', 'b', 'c']),
    a: page('a', 'Same', ['a1']),
    b: page('b', 'same'),
    c: page('c', 'Unfetched'),
    a1: page('a1', 'Deep'),
  };
  return {
    ...newStore(),
    blocks,
    expanded: new Set(['root', 'a', 'b', 'a1']),
    children: new Map([['root', ['a', 'b', 'c']], ['a', ['a1']]]),
  };
}

test('layout: children nest in a folder, same-name siblings get an id suffix (case-insensitive), unfetched pages are skipped', () => {
  const paths = layout(treeStore(), 'root');
  assert.deepEqual([...paths], [
    ['root', 'Root.md'],
    ['a', 'Root/Same.md'],
    ['a1', 'Root/Same/Deep.md'],
    ['b', 'Root/same-b.md'],
  ]);
});

test('layout: a page that lists an ancestor as its child does not recurse forever', () => {
  const store = treeStore();
  store.children.set('a1', ['root']);
  assert.equal(layout(store, 'root').size, 4);
});

test('writeTree: one file per page, relative encoded links to fetched pages, notion URL for the rest', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notion2md-test-'));
  try {
    const pages: Record<string, Record<string, any>[]> = {
      [ID]: [{ id: ID, type: 'page', space_id: 'sp', properties: { title: [['Knowledge Map']] }, content: ['c1', 'c2'] }, { id: 'c1', type: 'page', properties: { title: [['../../Evil']] }, content: [] }, { id: 'c2', type: 'page', properties: { title: [['Later']] }, content: ['t'] }],
      c1: [{ id: 'c1', type: 'page', properties: { title: [['../../Evil']] }, content: ['t'] }, { id: 't', type: 'text', properties: { title: [['child body']] } }],
      c2: [{ id: 'c2', type: 'page', properties: { title: [['Later']] }, content: ['t'] }],
    };
    const api: Api = async (endpoint, body: any) => (endpoint === 'loadCachedPageChunkV2' ? { recordMap: recordMap(...pages[body.page.id]!) } : { recordMap: {} });
    const store = await loadTree(api, ID, { depth: Infinity });
    writeTree(store, ID, dir);
    assert.deepEqual(readdirSync(dir, { recursive: true }).map(String).sort(), ['Knowledge Map', 'Knowledge Map.md', 'Knowledge Map/-..-Evil.md', 'Knowledge Map/Later.md']);
    const root = readFileSync(join(dir, 'Knowledge Map.md'), 'utf8');
    assert.match(root, /\[\.\.\/\.\.\/Evil\]\(Knowledge%20Map\/-\.\.-Evil\.md\)/);
    assert.match(readFileSync(join(dir, 'Knowledge Map/-..-Evil.md'), 'utf8'), /child body/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadTree: Infinity depth fetches the whole chain, and a page cycle terminates', async () => {
  const pages: Record<string, Record<string, any>[]> = {
    [ID]: [{ id: ID, type: 'page', space_id: 'sp', content: ['c1'] }, { id: 'c1', type: 'page', content: ['gc'] }],
    c1: [{ id: 'c1', type: 'page', content: ['gc'] }, { id: 'gc', type: 'page', content: [ID] }],
    gc: [{ id: 'gc', type: 'page', content: [ID] }, { id: ID, type: 'page', space_id: 'sp', content: ['c1'] }],
  };
  const api: Api = async (endpoint, body: any) => (endpoint === 'loadCachedPageChunkV2' ? { recordMap: recordMap(...pages[body.page.id]!) } : { recordMap: {} });
  const store = await loadTree(api, ID, { depth: Infinity });
  assert.deepEqual([...store.expanded], [ID, 'c1', 'gc']);
});

// --- host allow-list, timeout, progress, slug cap ---

test('parsePageId: only Notion hosts are accepted', () => {
  const id = '0123456789abcdef0123456789abcdef';
  for (const ok of [`https://notion.so/${id}`, `https://www.notion.so/a-${id}`, `https://app.notion.com/p/team/x-${id}`, `https://team.notion.site/x-${id}`, `http://www.notion.so/${id}`]) {
    assert.equal(parsePageId(ok), ID, ok);
  }
  for (const bad of [
    `https://attacker.example/x-${id}`,
    `https://notion.so.attacker.example/${id}`,
    `https://evilnotion.so/${id}`,
    `https://notion.so@attacker.example/${id}`,
    `https://attacker.example/?p=${id}&host=notion.so`,
    `ftp://www.notion.so/${id}`,
    `file:///tmp/${id}`,
    `javascript:alert(1)//${id}`,
  ]) assert.throws(() => parsePageId(bad), { code: 'BAD_INPUT', exit: 2 }, bad);
});

test('parseTimeout: default follows depth, junk and non-positive values are rejected', () => {
  assert.equal(parseTimeout(undefined, 0), 90);
  assert.equal(parseTimeout(undefined, 1), 1800);
  assert.equal(parseTimeout(undefined, Infinity), 1800);
  assert.equal(parseTimeout('5', 0), 5);
  assert.equal(parseTimeout('0.5', 0), 0.5);
  for (const bad of ['abc', '', '0', '-3', '1e3', '5s']) assert.throws(() => parseTimeout(bad, 0), { code: 'BAD_INPUT', exit: 2 }, bad);
});

test('loadTree: reports each fetched page once, with its nesting level', async () => {
  const pages: Record<string, Record<string, any>[]> = {
    [ID]: [{ id: ID, type: 'page', space_id: 'sp', properties: { title: [['Root']] }, content: ['c1'] }, { id: 'c1', type: 'page', properties: { title: [['Kid']] }, content: [] }],
    c1: [{ id: 'c1', type: 'page', properties: { title: [['Kid']] }, content: [] }],
  };
  const api: Api = async (endpoint, body: any) => (endpoint === 'loadCachedPageChunkV2' ? { recordMap: recordMap(...pages[body.page.id]!) } : { recordMap: {} });
  const seen: [string, number, number][] = [];
  await loadTree(api, ID, { depth: 1, onPage: (id, store, level) => seen.push([id, level, store.expanded.size]) });
  assert.deepEqual(seen, [[ID, 0, 1], ['c1', 1, 2]]);
});

test('slug: cutting at the cap never leaves a trailing dot or space', () => {
  for (const title of ['a'.repeat(79) + '.b', 'a'.repeat(79) + ' b', 'a'.repeat(78) + '. b']) assert.doesNotMatch(slug(title), /[. ]$/, title);
});

// --- following links and databases ---

const HUB = ID;
const P1 = '11111111-1111-1111-1111-111111111111';
const P2 = '22222222-2222-2222-2222-222222222222';
const P3 = '33333333-3333-3333-3333-333333333333';
const NODE = new Set(['page', 'collection_view', 'collection_view_page']);

function workspace() {
  const page = (id: string, title: string, content: string[] = [], extra: Record<string, any> = {}) => ({ id, type: 'page', space_id: 'sp', properties: { title: [[title]] }, content, ...extra });
  const text = (id: string, ...runs: any[]) => ({ id, type: 'text', properties: { title: runs } });
  const world: Record<string, Record<string, any>> = {
    [HUB]: page(HUB, 'Hub', ['t1', 't2', 'al', 'db', 'kid', 't3']),
    t1: text('t1', ['see '], ['‣', [['p', P1]]]),
    t2: text('t2', ['go', [['a', `/${P2.replaceAll('-', '')}`]]]),
    al: { id: 'al', type: 'alias', format: { alias_pointer: { id: P3 } } },
    t3: text('t3', ['‣', [['p', 'ghost']]]),
    db: { id: 'db', type: 'collection_view', collection_id: 'col1', view_ids: ['v1'], space_id: 'sp' },
    kid: page('kid', 'Kid', ['kt']),
    kt: text('kt', ['kid body']),
    [P1]: page(P1, 'Linked', ['p1t']),
    p1t: text('p1t', ['linked body']),
    [P2]: page(P2, 'ViaUrl'),
    [P3]: page(P3, 'ViaAlias'),
    r1: page('r1', 'Row A', ['r1t'], { parent_table: 'collection', parent_id: 'col1', properties: { title: [['Row A']], st: [['Done']], empty: [['']] } }),
    r1t: text('r1t', ['back to ', ], ['‣', [['p', HUB]]]),
    r2: page('r2', 'Row B', [], { parent_table: 'collection', parent_id: 'col1', properties: { title: [['Row B']], st: [['Open']] } }),
  };
  const collections: Record<string, Record<string, any>> = {
    col1: { name: [['Tasks']], schema: { title: { name: 'Name', type: 'title' }, st: { name: 'Status', type: 'select' }, empty: { name: 'Notes', type: 'text' } } },
  };
  const calls: string[] = [];
  const chunk = (id: string) => {
    const out: Record<string, any>[] = [];
    const walk = (bid: string, top: boolean) => {
      const b = world[bid];
      if (!b) return;
      out.push(b);
      if (top || !NODE.has(b.type)) for (const c of b.content ?? []) walk(c, false);
    };
    walk(id, true);
    return out;
  };
  const api: Api = async (endpoint, body: any) => {
    calls.push(endpoint);
    if (endpoint === 'loadCachedPageChunkV2') return { recordMap: recordMap(...chunk(body.page.id)) };
    if (endpoint === 'queryCollection') {
      return {
        result: { reducerResults: { collection_group_results: { blockIds: ['r1', 'r2'] } } },
        recordMap: { ...recordMap(world.r1!, world.r2!), collection: { col1: { value: { value: collections.col1 } } } } as any,
      };
    }
    if (body.requests[0].pointer.table === 'collection') {
      return { recordMap: { collection: Object.fromEntries(body.requests.map((r: any) => [r.pointer.id, { value: { value: collections[r.pointer.id] } }])) } as any };
    }
    return { recordMap: recordMap(...body.requests.map((r: any) => world[r.pointer.id]).filter(Boolean)) };
  };
  return { api, calls };
}

test('linkedPageId and parseMaxPages', () => {
  const raw = '0123456789abcdef0123456789abcdef';
  assert.equal(linkedPageId(`/${raw}`), ID);
  assert.equal(linkedPageId(`/${raw}#block`), ID);
  assert.equal(linkedPageId(`https://www.notion.so/team/x-${raw}?pvs=4`), ID);
  for (const no of ['https://example.com/x', `https://attacker.example/${raw}`, '/not-an-id', '#top', 'mailto:a@b.c']) assert.equal(linkedPageId(no), undefined, no);
  assert.equal(parseMaxPages(undefined), 1000);
  assert.equal(parseMaxPages('all'), Infinity);
  assert.equal(parseMaxPages('7'), 7);
  for (const bad of ['0', '-1', '1.5', 'x', '']) assert.throws(() => parseMaxPages(bad), { code: 'BAD_INPUT', exit: 2 }, bad);
});

test('crawl: depth 0 follows nothing and never queries a database', async () => {
  const { api, calls } = workspace();
  const store = await loadTree(api, HUB);
  assert.deepEqual([...store.expanded], [HUB]);
  assert.equal(calls.includes('queryCollection'), false);
});

test('crawl: depth 1 reaches mentions, internal links, aliases, nested pages and databases, but not the rows', async () => {
  const { api } = workspace();
  const store = await loadTree(api, HUB, { depth: 1 });
  assert.deepEqual([...store.expanded].sort(), [HUB, P1, P2, P3, 'db', 'kid'].sort());
  assert.deepEqual([...store.noAccess], [['ghost', HUB]]);
  assert.equal(store.truncated, undefined);
});

test('crawl: unlimited depth also fetches database rows once, and a link back to the root is not a loop', { timeout: 5000 }, async () => {
  const { api, calls } = workspace();
  const store = await loadTree(api, HUB, { depth: Infinity });
  assert.deepEqual([...store.expanded].sort(), [HUB, P1, P2, P3, 'db', 'kid', 'r1', 'r2'].sort());
  assert.equal(calls.filter((c) => c === 'queryCollection').length, 1);
});

test('crawl: --max-pages stops early, keeps what was fetched and reports what was left', async () => {
  const { api } = workspace();
  const store = await loadTree(api, HUB, { depth: Infinity, maxPages: 3 });
  assert.equal(store.expanded.size, 3);
  assert.equal(store.truncated, 'max-pages');
  assert.ok(store.skipped.length > 0);
  const exact = await loadTree(workspace().api, HUB, { depth: Infinity, maxPages: 8 });
  assert.equal(exact.truncated, undefined, 'a cap equal to the page count is not a truncation');
});

test('crawl: an abort signal stops before the next page and keeps the first', async () => {
  const stop = new AbortController();
  const store = await loadTree(workspace().api, HUB, { depth: Infinity, signal: stop.signal, onPage: () => stop.abort() });
  assert.deepEqual([...store.expanded], [HUB]);
  assert.equal(store.truncated, 'aborted');
  const early = new AbortController();
  early.abort();
  assert.equal((await loadTree(workspace().api, HUB, { depth: 1, signal: early.signal })).expanded.size, 1, 'the root is always fetched');
});

test('crawl: a database can be the root, its rows follow at depth 1', async () => {
  const { api } = workspace();
  const store = await loadTree(api, 'db', { depth: 1 });
  assert.deepEqual([...store.expanded], ['db', 'r1', 'r2']);
  assert.equal(toMarkdown(store, 'db'), '# Tasks\n\n- [Row A](https://www.notion.so/r1)\n- [Row B](https://www.notion.so/r2)\n');
});

test('writeTree: links between fetched pages become file links, databases get an index, rows list their fields', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notion2md-test-'));
  try {
    const store = await loadTree(workspace().api, HUB, { depth: Infinity });
    writeTree(store, HUB, dir);
    assert.deepEqual(readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith('.md')).sort(), [
      'Hub.md', 'Hub/Kid.md', 'Hub/Tasks.md', 'Hub/Tasks/Row A.md', 'Hub/Tasks/Row B.md', '_linked/Linked.md', '_linked/ViaAlias.md', '_linked/ViaUrl.md', '_no-access.md',
    ]);
    const read = (f: string) => readFileSync(join(dir, f), 'utf8');
    const hub = read('Hub.md');
    assert.match(hub, /see \[Linked\]\(_linked\/Linked\.md\)/);
    assert.match(hub, /\[go\]\(_linked\/ViaUrl\.md\)/);
    assert.match(hub, /\[ViaAlias\]\(_linked\/ViaAlias\.md\)/);
    assert.match(hub, /\[Database: Tasks\]\(Hub\/Tasks\.md\)/);
    assert.match(hub, /\[page\]\(https:\/\/www\.notion\.so\/ghost\)/, 'an unreadable link keeps its URL');
    assert.equal(read('Hub/Tasks.md'), '# Tasks\n\n- [Row A](Tasks/Row%20A.md)\n- [Row B](Tasks/Row%20B.md)\n');
    assert.equal(read('Hub/Tasks/Row A.md'), '# Row A\n\n- **Status:** Done\n\nback to [Hub](../../Hub.md)\n');
    assert.equal(read('Hub/Tasks/Row B.md'), '# Row B\n\n- **Status:** Open\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- rate limits and failures in the middle of a crawl ---

test('apiError: 429 is a rate limit, 400/401/403/404 are no access, everything else is a plain API error', () => {
  assert.equal(apiError('x', 429, '').code, 'RATE_LIMITED');
  for (const status of [400, 401, 403, 404]) assert.deepEqual([apiError('x', status, '').code, apiError('x', status, '').exit], ['NO_ACCESS', 4], String(status));
  for (const status of [408, 409, 500, 502]) assert.equal(apiError('x', status, 'boom').code, 'API_ERROR', String(status));
  assert.match(apiError('queryCollection', 500, 'boom').message, /queryCollection.*500.*boom/);
});

test('crawl: a failure on a page keeps the pages before it, reports the page it died on, and stays writable', async () => {
  const inner = workspace().api;
  let loads = 0;
  const flaky: Api = async (endpoint, body: any) => {
    if (endpoint === 'loadCachedPageChunkV2' && ++loads === 3) throw apiError(endpoint, 429, '');
    return inner(endpoint, body);
  };
  const store = await loadTree(flaky, HUB, { depth: Infinity });
  assert.equal(store.truncated, 'error');
  assert.match(store.error!, /rate limit/);
  assert.deepEqual([...store.expanded], [HUB, 'db', 'kid']);
  assert.equal(store.skipped[0], P1, 'the page that failed is first in the skipped list');
  const dir = mkdtempSync(join(tmpdir(), 'notion2md-test-'));
  try {
    assert.equal(writeTree(store, HUB, dir).size, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('crawl: errors that are not CliErrors are bugs and still propagate, and a failing root is still fatal', async () => {
  const inner = workspace().api;
  let loads = 0;
  const buggy: Api = async (endpoint, body) => {
    if (endpoint === 'loadCachedPageChunkV2' && ++loads === 2) throw new TypeError('boom');
    return inner(endpoint, body);
  };
  await assert.rejects(loadTree(buggy, HUB, { depth: 1 }), TypeError);
  await assert.rejects(loadTree(async () => { throw new CliError('RATE_LIMITED', 'x'); }, HUB, { depth: 1 }), { code: 'RATE_LIMITED' });
});

// --- no access: record the page, skip it, keep going ---

const refuse = () => apiError('x', 403, '');

test('no access: a refused page is recorded with the page that linked to it, and the crawl goes on', async () => {
  const inner = workspace().api;
  const api: Api = async (endpoint, body: any) => {
    if (endpoint === 'loadCachedPageChunkV2' && body.page.id === P2) throw refuse();
    return inner(endpoint, body);
  };
  const store = await loadTree(api, HUB, { depth: Infinity });
  assert.deepEqual([...store.noAccess].filter(([id]) => id === P2), [[P2, HUB]]);
  assert.equal(store.truncated, undefined);
  assert.equal(store.error, undefined);
  for (const id of [P1, P3, 'kid', 'db', 'r1', 'r2']) assert.ok(store.expanded.has(id), id);
  assert.equal(store.expanded.has(P2), false);
});

test('no access: a refused database is skipped without its rows, a refused batch of links marks them all', async () => {
  const inner = workspace().api;
  const noDb: Api = async (endpoint, body: any) => {
    if (endpoint === 'queryCollection') throw refuse();
    return inner(endpoint, body);
  };
  const a = await loadTree(noDb, HUB, { depth: Infinity });
  assert.deepEqual([...a.noAccess].filter(([id]) => id === 'db'), [['db', HUB]]);
  assert.equal(a.expanded.has('r1'), false);
  assert.ok(a.expanded.has(P1));

  const noLinks: Api = async (endpoint, body: any) => {
    if (endpoint === 'syncRecordValues' && body.requests.some((r: any) => r.pointer.id === P1)) throw refuse();
    return inner(endpoint, body);
  };
  const b = await loadTree(noLinks, HUB, { depth: 1 });
  assert.deepEqual([...b.noAccess.keys()].sort(), [P1, P2, P3, 'ghost'].sort());
  assert.ok(b.expanded.has('kid'));
  assert.equal(b.truncated, undefined);
});

test('no access: the list lands in _no-access.md next to the pages, with a link back to the page that led there', async () => {
  const inner = workspace().api;
  const api: Api = async (endpoint, body: any) => {
    if (endpoint === 'loadCachedPageChunkV2' && body.page.id === P2) throw refuse();
    return inner(endpoint, body);
  };
  const dir = mkdtempSync(join(tmpdir(), 'notion2md-test-'));
  try {
    const store = await loadTree(api, HUB, { depth: Infinity });
    writeTree(store, HUB, dir);
    const report = readFileSync(join(dir, '_no-access.md'), 'utf8');
    assert.match(report, /^# Pages without access/);
    assert.match(report, /- \[ViaUrl\]\(https:\/\/www\.notion\.so\/22222222222222222222222222222222\) \(linked from \[Hub\]\(Hub\.md\)\)/);
    assert.match(report, /- \[ghost\]\(https:\/\/www\.notion\.so\/ghost\) \(linked from \[Hub\]\(Hub\.md\)\)/);
    const clean = await loadTree(workspace().api, HUB, { depth: Infinity });
    const dir2 = mkdtempSync(join(tmpdir(), 'notion2md-test-'));
    writeTree({ ...clean, noAccess: new Map() }, HUB, dir2);
    assert.equal(readdirSync(dir2, { recursive: true }).map(String).includes('_no-access.md'), false, 'no file when nothing was refused');
    rmSync(dir2, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pacer: no delay until Notion pushes back, then 300 ms doubling up to 3 s, easing off after 20 clean calls', async () => {
  const pacer = createPacer();
  const t0 = Date.now();
  await pacer.wait();
  assert.ok(Date.now() - t0 < 50, 'no wait before the first 429');
  const seen: number[] = [];
  for (let i = 0; i < 6; i++) { pacer.slowDown(); seen.push(pacer.delay); }
  assert.deepEqual(seen, [300, 600, 1200, 2400, 3000, 3000]);
  for (let i = 0; i < 19; i++) pacer.succeeded();
  assert.equal(pacer.delay, 3000, '19 clean calls are not enough');
  pacer.succeeded();
  assert.equal(pacer.delay, 1500);
  pacer.slowDown();
  for (let i = 0; i < 19; i++) pacer.succeeded();
  assert.equal(pacer.delay, 3000, 'a 429 restarts the count');
  for (let i = 0; i < 20 * 6; i++) pacer.succeeded();
  assert.equal(pacer.delay, 0, 'back to no delay once it is calm for long enough');
});

test('layout: pages reached only through links go flat in _linked/, never nested by who linked first', () => {
  const store = treeStore();
  // "deep" was found through "b" but is not part of b's contents; "deeper" through "deep".
  for (const id of ['deep', 'deeper']) {
    store.blocks[id] = { id, type: 'page', properties: { title: [[id]] } };
    store.expanded.add(id);
  }
  const paths = layout(store, 'root');
  assert.equal(paths.get('deep'), '_linked/deep.md');
  assert.equal(paths.get('deeper'), '_linked/deeper.md');
  assert.equal(paths.get('b'), 'Root/same-b.md', 'contained pages keep nesting under their parent');
  const longest = Math.max(...[...paths.values()].map((p) => p.length));
  assert.ok(longest < 40, `paths stay short, longest is ${longest}`);
});

test('layout: a linked page that contains pages keeps its own contents nested beside it', () => {
  const store = treeStore();
  store.blocks.lp = { id: 'lp', type: 'page', properties: { title: [['LP']] } };
  store.blocks.lc = { id: 'lc', type: 'page', properties: { title: [['LC']] } };
  store.expanded.add('lp');
  store.expanded.add('lc');
  store.children.set('lp', ['lc']);
  const paths = layout(store, 'root');
  assert.deepEqual([paths.get('lp'), paths.get('lc')], ['_linked/LP.md', '_linked/LP/LC.md']);
});

test('markdown: an empty callout or quote title does not leave bare ">" lines around its children', () => {
  const blocks: Record<string, Block> = {
    r: { id: 'r', type: 'page', properties: { title: [['T']] }, content: ['c'] },
    c: { id: 'c', type: 'callout', content: ['k1', 'k2'] },
    k1: { id: 'k1', type: 'text', properties: { title: [['first']] } },
    k2: { id: 'k2', type: 'text', properties: { title: [['second']] } },
  };
  assert.equal(toMarkdown({ blocks, collections: {} }, 'r'), '# T\n\n> first\n>\n> second\n');
});
