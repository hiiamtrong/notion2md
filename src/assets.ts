import { createWriteStream, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CliError } from './errors.ts';
import type { Download } from './session.ts';
import type { Api, Block, Store } from './types.ts';

export const ASSET_TYPES = new Set(['image', 'file', 'video', 'audio', 'pdf']);

/** A video or embed block can hold an outside URL (YouTube, Figma): that is a link, not a file, so it stays one. */
const NOTION_HOSTED = /^attachment:|secure\.notion-static\.com|prod-files-secure|file\.notion\.com/;
// 90 bytes per name plus the 13-byte id prefix and the extension stays under the 255-byte limit of ext4 and SMB.
const NAME_BYTES = 90;
// The cleanup below deletes every file in the assets folder carrying this suffix, so it must not collide with
// another tool's in-progress download.
const PART = '.notion2md-part';
const SIGN_BATCH = 50;

export interface Asset {
  blockId: string;
  source: string;
  name: string;
}

export interface SavedAssets {
  names: Map<string, string>;
  failed: number;
}

function cutBytes(s: string, max: number): string {
  const buf = Buffer.from(s);
  if (buf.length <= max) return s;
  let end = max;
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

function storedName(source: string, fallback: string): string {
  if (source.startsWith('attachment:')) return source.split(':').slice(2).join(':') || fallback;
  try {
    return decodeURIComponent(new URL(source).pathname.split('/').pop() || '') || fallback;
  } catch {
    return fallback;
  }
}

export function assetName(a: Asset): string {
  const safe = a.name.replace(/[/\\:*?"<>|\u0000-\u001f]+/g, '_');
  const raw = extname(safe);
  const ext = raw.slice(0, 10);
  const base = raw ? safe.slice(0, -raw.length) : safe;
  // Blocks created together share their first 8 hex chars, so only the id tail keeps two `image.png` apart.
  return `${a.blockId.replaceAll('-', '').slice(-12)}-${cutBytes(base, NAME_BYTES - Buffer.byteLength(ext)) || 'file'}${ext}`;
}

/** Two blocks with the same stored name must not write over each other: the second gets a counter. */
function freeName(name: string, used: Set<string>): string {
  let out = name;
  for (let n = 2; used.has(out); n++) out = name.replace(/(\.[^.]*)?$/, `-${n}$1`);
  used.add(out);
  return out;
}

const sourceOf = (b: Block) => (b.properties?.source ?? []).map((r) => r[0]).join('');

export function collectAssets(store: Store): Asset[] {
  const assets = new Map<string, Asset>();
  for (const b of Object.values(store.blocks)) {
    if (b.alive === false) continue;
    const cover: unknown = b.format?.page_cover;
    if (b.type === 'page' && typeof cover === 'string' && NOTION_HOSTED.test(cover)) {
      assets.set(b.id, { blockId: b.id, source: cover, name: storedName(cover, 'cover') });
    }
    if (!ASSET_TYPES.has(b.type)) continue;
    const source = sourceOf(b);
    if (!source || !NOTION_HOSTED.test(source)) continue;
    assets.set(b.id, { blockId: b.id, source, name: storedName(source, b.type) });
  }
  return [...assets.values()];
}

/**
 * `getSignedFileUrls` answers in the order it was asked, and a file this profile cannot read comes back empty,
 * so the pairing is by index and not by URL. Notion rejects the whole request when one url cannot be signed,
 * so a failed batch is split until the bad asset stands alone: one dead file must not cost the other 49.
 */
export async function signedUrls(api: Api, assets: Asset[], log: (m: string) => void): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ask = async (batch: Asset[]): Promise<void> => {
    const first = batch[0];
    if (!first) return;
    let res: { signedUrls?: (string | null)[] };
    try {
      res = (await api('getSignedFileUrls', {
        urls: batch.map((a) => ({ url: a.source, permissionRecord: { table: 'block', id: a.blockId } })),
      })) as { signedUrls?: (string | null)[] };
    } catch (e) {
      // Only a per-entry rejection is worth splitting: Notion fails the whole request when one url cannot be
      // signed. A rate limit or a 5xx would just be answered the same way for every smaller batch.
      const code = e instanceof CliError ? e.code : undefined;
      if (batch.length === 1 || code !== 'NO_ACCESS') {
        log(`No download link for ${assetName(first)}: ${(e as Error).message}`);
        return;
      }
      const mid = Math.ceil(batch.length / 2);
      await ask(batch.slice(0, mid));
      await ask(batch.slice(mid));
      return;
    }
    (res.signedUrls ?? []).forEach((url, n) => {
      const a = batch[n];
      if (a && url) out.set(a.blockId, url);
    });
  };
  for (let i = 0; i < assets.length; i += SIGN_BATCH) await ask(assets.slice(i, i + SIGN_BATCH));
  return out;
}

export async function saveAssets(
  assets: Asset[],
  signed: Map<string, string>,
  dir: string,
  download: Download,
  log: (m: string) => void,
): Promise<SavedAssets> {
  const names = new Map<string, string>();
  const used = new Set<string>();
  const failed = new Set<string>();
  mkdirSync(dir, { recursive: true });
  // A run killed mid-download leaves temp files behind, and they are never valid input for a later one.
  for (const f of readdirSync(dir, { withFileTypes: true })) if (f.isFile() && f.name.endsWith(PART)) rmSync(join(dir, f.name), { force: true });
  for (const a of assets) {
    const name = freeName(assetName(a), used);
    const url = signed.get(a.blockId);
    if (!url) {
      failed.add(a.blockId);
      log(`No download link for ${name}`);
      continue;
    }
    const part = join(dir, `${name}${PART}`);
    try {
      const res = await download(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!res.body) throw new Error('empty response');
      await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(part));
      renameSync(part, join(dir, name));
      names.set(a.blockId, name);
    } catch (e) {
      rmSync(part, { force: true });
      failed.add(a.blockId);
      log(`Could not save ${name}: ${(e as Error).message}`);
    }
  }
  return { names, failed: failed.size };
}

export function encodePath(p: string): string {
  // A Windows drive letter carries a colon that must stay literal, or the link points nowhere.
  return p.split(sep).join('/').split('/').map((s, i) => (i === 0 && /^[A-Za-z]:$/.test(s) ? s : encodeURIComponent(s))).join('/');
}

export function assetLink(fromDir: string, assetsDir: string, name: string): string {
  return encodePath(relative(fromDir, join(assetsDir, name)));
}
