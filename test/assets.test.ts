import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assetLink, assetName, collectAssets, encodePath, saveAssets, signedUrls, type Asset } from '../src/assets.ts';
import { CliError } from '../src/errors.ts';
import { toMarkdown } from '../src/markdown.ts';
import type { Api, Block, Store } from '../src/types.ts';

const store = (blocks: Record<string, Block>): Store => ({
  blocks, collections: {}, users: {}, discussions: {}, comments: {}, expanded: new Set(), children: new Map(), rows: new Map(),
  spaceId: 'sp', gone: new Set(), noAccess: new Map(), skipped: [], truncated: undefined, error: undefined,
});
const asset = (blockId: string, name: string): Asset => ({ blockId, source: `attachment:uuid:${name}`, name });

test('assetName: the id tail keeps two files apart, extension kept, long CJK name capped in bytes', () => {
  assert.equal(assetName(asset('3e3926e2-09a3-8073-9657-d4807930a20d', 'image.png')), 'd4807930a20d-image.png');
  assert.equal(assetName(asset('aaaaaaa1-0000-0000-0000-000000000000', 'a/b:c?.zip')), '000000000000-a_b_c_.zip');
  const long = assetName(asset('bbbbbbb2-0000-0000-0000-000000000000', `${'截圖'.repeat(60)}.mp4`));
  assert.ok(long.endsWith('.mp4'));
  assert.ok(!long.includes('\uFFFD'), 'a character cut in half would show as U+FFFD');
  assert.ok(Buffer.byteLength(long) <= 255);
  assert.equal(assetName(asset('ccccccc3-0000-0000-0000-000000000000', '')), '000000000000-file');
});

test('collectAssets: an empty store, and blocks with no payload, give nothing to download', () => {
  assert.deepEqual(collectAssets(store({})), []);
  assert.deepEqual(collectAssets(store({
    text: { id: 'text', type: 'text', properties: { title: [['hi']] } },
    bare: { id: 'bare', type: 'image' },
    empty: { id: 'empty', type: 'image', properties: { source: [] } },
    // format is a bag of any: a cover that is not a string must not become an asset.
    page: { id: 'page', type: 'page', format: { page_cover: { url: 'x' } } },
  })), []);
});

test('collectAssets: a source that names no file falls back to the block type', () => {
  const assets = collectAssets(store({
    a: { id: 'a', type: 'file', properties: { source: [['attachment:uuid:']] } },
    b: { id: 'b', type: 'image', properties: { source: [['https://prod-files-secure.s3/x/']] } },
  }));
  assert.deepEqual(assets.map((x) => x.name), ['file', 'image']);
});

test('signedUrls: nothing to sign makes no request', async () => {
  let calls = 0;
  const api: Api = async () => {
    calls++;
    return {} as never;
  };
  assert.equal((await signedUrls(api, [], () => {})).size, 0);
  assert.equal(calls, 0);
});

test('signedUrls: a response without signedUrls, or shorter than the batch, maps what it got', async () => {
  const empty: Api = async () => ({}) as never;
  assert.equal((await signedUrls(empty, [asset('b1', 'x.png')], () => {})).size, 0);

  const short: Api = async () => ({ signedUrls: ['https://file.notion.com/only'] }) as never;
  const signed = await signedUrls(short, [asset('b1', 'x.png'), asset('b2', 'y.png'), asset('b3', 'z.png')], () => {});
  assert.deepEqual([...signed], [['b1', 'https://file.notion.com/only']]);
});

test('saveAssets: two assets that land on the same name still get their own file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notion2md-assets-'));
  try {
    const a = asset('aaaaaaa1-0000-0000-0000-d4807930a20d', 'image.png');
    const b = asset('bbbbbbb2-0000-0000-0000-d4807930a20d', 'image.png');
    const signed = new Map([[a.blockId, 'https://file.notion.com/1'], [b.blockId, 'https://file.notion.com/2']]);
    const download = async (url: string) => new Response(new Uint8Array(url.endsWith('/1') ? [1] : [2]));
    const saved = await saveAssets([a, b], signed, dir, download, () => {});
    assert.equal(saved.failed, 0);
    assert.deepEqual([...saved.names.values()], ['d4807930a20d-image.png', 'd4807930a20d-image-2.png']);
    assert.deepEqual([...readFileSync(join(dir, 'd4807930a20d-image.png'))], [1]);
    assert.deepEqual([...readFileSync(join(dir, 'd4807930a20d-image-2.png'))], [2]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('signedUrls: one url that cannot be signed costs only itself, the rest of the batch still signs', async () => {
  const logs: string[] = [];
  const api: Api = async (_endpoint, body) => {
    const urls = (body as { urls: { url: string }[] }).urls;
    if (urls.some((u) => u.url.endsWith('dead.png'))) throw new CliError('NO_ACCESS', 'Notion rejected getSignedFileUrls (404)', undefined, 4);
    return { signedUrls: urls.map((u) => `https://file.notion.com/${u.url}`) } as never;
  };
  const signed = await signedUrls(api, [asset('a1', 'one.png'), asset('a2', 'dead.png'), asset('a3', 'three.png')], (m) => logs.push(m));
  assert.deepEqual([...signed.keys()], ['a1', 'a3']);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /No download link for .*dead\.png: Notion rejected/);
});

test('signedUrls: a rate limit is not worth splitting, one call is enough to know', async () => {
  const logs: string[] = [];
  let calls = 0;
  const api: Api = async () => {
    calls++;
    throw new CliError('RATE_LIMITED', 'Notion rate limit hit on getSignedFileUrls (429)', undefined, 1);
  };
  const signed = await signedUrls(api, [asset('a1', 'one.png'), asset('a2', 'two.png'), asset('a3', 'three.png')], (m) => logs.push(m));
  assert.equal(signed.size, 0);
  assert.equal(calls, 1);
  assert.match(logs[0]!, /No download link for .*one\.png: Notion rate limit/);
});

test('saveAssets: our temp file is cleared before the next run, another tool\u0027s .part is left alone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notion2md-assets-'));
  try {
    writeFileSync(join(dir, 'd4807930a20d-old.png.notion2md-part'), 'half');
    writeFileSync(join(dir, 'downloading.part'), 'another tool');
    writeFileSync(join(dir, 'keep.png'), 'full');
    await saveAssets([], new Map(), dir, async () => new Response(''), () => {});
    assert.deepEqual(readdirSync(dir).sort(), ['downloading.part', 'keep.png']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saveAssets: an empty list writes nothing and downloads nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notion2md-assets-'));
  let calls = 0;
  try {
    const saved = await saveAssets([], new Map(), dir, async () => {
      calls++;
      return new Response('');
    }, () => {});
    assert.equal(saved.failed, 0);
    assert.equal(saved.names.size, 0);
    assert.equal(calls, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saveAssets: a response with no body is a failure, not an empty file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notion2md-assets-'));
  try {
    const one = asset('aaaaaaa1-0000-0000-0000-000000000000', 'x.png');
    const saved = await saveAssets([one], new Map([[one.blockId, 'https://file.notion.com/x']]), dir, async () => new Response(null), () => {});
    assert.equal(saved.failed, 1);
    assert.equal(existsSync(join(dir, '000000000000-x.png')), false);
    assert.equal(existsSync(join(dir, '000000000000-x.png.notion2md-part')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('assetLink: the assets folder itself gives a bare encoded name', () => {
  assert.equal(assetLink('/out', '/out', 'a b.png'), 'a%20b.png');
});

test('encodePath: a Windows drive letter stays literal, the rest is encoded', () => {
  assert.equal(encodePath('D:/att/a b.png'), 'D:/att/a%20b.png');
  assert.equal(encodePath('/tmp/att/a b.png'), '/tmp/att/a%20b.png');
});

test('saveAssets: a directory named like our temp file is left alone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notion2md-assets-'));
  try {
    mkdirSync(join(dir, 'sub.notion2md-part'));
    await saveAssets([], new Map(), dir, async () => new Response(''), () => {});
    assert.deepEqual(readdirSync(dir), ['sub.notion2md-part']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const noPayload: Record<string, Block> = {
  r: { id: 'r', type: 'page', properties: { title: [['Doc']] }, content: ['img', 'file'] },
  img: { id: 'img', type: 'image', properties: {} },
  file: { id: 'file', type: 'file' },
};

test('markdown: a block with no payload renders nothing, even when a downloaded asset shares its id', () => {
  assert.equal(toMarkdown(store(noPayload), 'r'), '# Doc\n');
  const known = new Map([['img', 'i.png']]);
  assert.equal(toMarkdown(store(noPayload), 'r', undefined, (id) => known.get(id)), '# Doc\n');
  // A downloaded cover is the page block's own id, so it is the one payload an otherwise empty page still shows.
  const withCover = new Map([['r', 'cover.png']]);
  assert.equal(toMarkdown(store(noPayload), 'r', undefined, (id) => withCover.get(id)), '![](cover.png)\n\n# Doc\n');
});

test('assetName: blocks that share an id prefix and a name still get two files', () => {
  const first = asset('349926e2-09a3-80ae-bfa5-ff57be465735', 'image.png');
  const second = asset('349926e2-09a3-80da-9333-e44731ff8261', 'image.png');
  assert.notEqual(assetName(first), assetName(second));
  assert.equal(assetName(first), 'ff57be465735-image.png');
  assert.equal(assetName(second), 'e44731ff8261-image.png');
});

test('collectAssets: Notion files and covers only, outside URLs stay links', () => {
  const s = store({
    page: { id: 'page', type: 'page', alive: true, format: { page_cover: 'attachment:u1:cover.png' } },
    img: { id: 'img', type: 'image', alive: true, properties: { source: [['attachment:u2:image.png']] } },
    pdf: { id: 'pdf', type: 'pdf', alive: true, properties: { source: [['https://prod-files-secure.s3/x/y/report.pdf']] } },
    yt: { id: 'yt', type: 'video', alive: true, properties: { source: [['https://www.youtube.com/watch?v=1']] } },
    embed: { id: 'embed', type: 'embed', alive: true, properties: { source: [['https://www.figma.com/file/1']] } },
    dead: { id: 'dead', type: 'image', alive: false, properties: { source: [['attachment:u3:gone.png']] } },
    text: { id: 'text', type: 'text', alive: true, properties: { title: [['hi']] } },
  });
  assert.deepEqual(collectAssets(s).map((a) => [a.blockId, a.name]), [
    ['page', 'cover.png'],
    ['img', 'image.png'],
    ['pdf', 'report.pdf'],
  ]);
});

test('signedUrls: asks in batches of 50 and pairs the answers by index', async () => {
  const calls: number[] = [];
  const api: Api = async (endpoint, body) => {
    assert.equal(endpoint, 'getSignedFileUrls');
    const urls = (body as { urls: { url: string; permissionRecord: { id: string } }[] }).urls;
    calls.push(urls.length);
    // The second answer of every batch is null: a file this profile may not read.
    return { signedUrls: urls.map((u, i) => (i === 1 ? null : `https://file.notion.com/${u.permissionRecord.id}`)) } as never;
  };
  const assets = Array.from({ length: 51 }, (_, i) => asset(`b${i}`, 'x.png'));
  const signed = await signedUrls(api, assets, () => {});
  assert.deepEqual(calls, [50, 1]);
  assert.equal(signed.get('b0'), 'https://file.notion.com/b0');
  assert.equal(signed.has('b1'), false);
  assert.equal(signed.get('b50'), 'https://file.notion.com/b50');
});

test('saveAssets: writes bytes, leaves no temp file, counts a failed download instead of stopping', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notion2md-assets-'));
  const logs: string[] = [];
  const download = async (url: string) =>
    url.endsWith('/bad') ? new Response('nope', { status: 403 }) : new Response(new Uint8Array([1, 2, 3]));
  try {
    const assets = [asset('aaaaaaa1-0000-0000-0000-000000000000', 'ok.png'), asset('bbbbbbb2-0000-0000-0000-000000000000', 'bad.pdf')];
    const signed = new Map([
      ['aaaaaaa1-0000-0000-0000-000000000000', 'https://file.notion.com/ok'],
      ['bbbbbbb2-0000-0000-0000-000000000000', 'https://file.notion.com/bad'],
    ]);
    const saved = await saveAssets(assets, signed, dir, download, (m) => logs.push(m));
    assert.equal(saved.failed, 1);
    assert.equal(saved.names.get('aaaaaaa1-0000-0000-0000-000000000000'), '000000000000-ok.png');
    assert.deepEqual([...readFileSync(join(dir, '000000000000-ok.png'))], [1, 2, 3]);
    assert.equal(existsSync(join(dir, '000000000000-bad.pdf')), false);
    assert.equal(existsSync(join(dir, '000000000000-bad.pdf.notion2md-part')), false);
    assert.match(logs.join('\n'), /Could not save 000000000000-bad\.pdf: HTTP 403/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saveAssets: an asset with no signed url is a failure, not a crash', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notion2md-assets-'));
  const logs: string[] = [];
  try {
    const saved = await saveAssets([asset('aaaaaaa1-0000-0000-0000-000000000000', 'x.png')], new Map(), dir, async () => new Response(''), (m) => logs.push(m));
    assert.equal(saved.failed, 1);
    assert.equal(saved.names.size, 0);
    assert.match(logs.join('\n'), /No download link for 000000000000-x\.png/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('assetLink: relative to the page, with spaces encoded', () => {
  assert.equal(assetLink('/out/Sub Dir', '/out/_assets', 'a1-image file.png'), '../_assets/a1-image%20file.png');
});

test('markdown: downloaded assets replace the dead links, outside links stay', () => {
  const blocks: Record<string, Block> = {
    r: { id: 'r', type: 'page', format: { page_cover: 'attachment:u1:cover.png' }, properties: { title: [['Doc']] }, content: ['img', 'pdf', 'yt'] },
    img: { id: 'img', type: 'image', properties: { source: [['attachment:u2:image.png']], caption: [['shot']] } },
    pdf: { id: 'pdf', type: 'pdf', properties: { source: [['attachment:u3:report.pdf']], title: [['report']] } },
    yt: { id: 'yt', type: 'video', properties: { source: [['https://www.youtube.com/watch?v=1']], title: [['demo']] } },
  };
  const local = new Map([['r', 'cover.png'], ['img', 'image.png'], ['pdf', 'report.pdf']]);
  const md = toMarkdown(store(blocks), 'r', undefined, (id) => local.get(id));
  assert.match(md, /^!\[\]\(cover\.png\)\n\n# Doc/);
  assert.match(md, /!\[shot\]\(image\.png\)/);
  assert.match(md, /\[report\]\(report\.pdf\)/);
  assert.match(md, /\[demo\]\(https:\/\/www\.youtube\.com\/watch\?v=1\)/);
});

test('markdown: without assets an image keeps the notion.so proxy and a file keeps its source', () => {
  const blocks: Record<string, Block> = {
    r: { id: 'r', type: 'page', properties: { title: [['Doc']] }, content: ['img', 'pdf'] },
    img: { id: 'img', type: 'image', properties: { source: [['attachment:u2:image.png']] } },
    pdf: { id: 'pdf', type: 'pdf', properties: { source: [['attachment:u3:report.pdf']] } },
  };
  const md = toMarkdown(store(blocks), 'r');
  assert.match(md, /!\[\]\(https:\/\/www\.notion\.so\/image\/attachment%3Au2%3Aimage\.png\?table=block&id=img&cache=v2\)/);
  assert.match(md, /\[attachment:u3:report\.pdf\]/);
});
