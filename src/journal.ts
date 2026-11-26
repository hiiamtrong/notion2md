import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import type { Block, Collection } from './types.ts';

/**
 * What one finished page added to a crawl. One JSON line each, appended as the crawl goes, so a run that is
 * stopped or killed can continue from the lines already written. `refused` is a list of [page, page that linked it].
 */
export interface Entry {
  root?: string;
  done?: string;
  spaceId?: string;
  blocks?: Record<string, Block>;
  collections?: Record<string, Collection>;
  rows?: string[];
  children?: string[];
  queued?: [id: string, level: number, from: string][];
  refused?: [string, string][];
}

const BLOCK_FIELDS = ['id', 'type', 'version', 'created_time', 'last_edited_time', 'created_by_id', 'created_by_table', 'last_edited_by_id', 'last_edited_by_table', 'alive', 'space_id', 'content', 'properties', 'format', 'collection_id', 'view_ids', 'parent_table', 'parent_id', 'discussions'] as const;

/** Only the fields the tool reads: Notion's records also carry edit history and permissions, which made a journal 10x the size of the Markdown. */
export function slimBlock(b: Block): Block {
  return Object.fromEntries(BLOCK_FIELDS.filter((f) => b[f] !== undefined).map((f) => [f, b[f]])) as unknown as Block;
}

export function slimCollection(c: Collection): Collection {
  const schema = Object.fromEntries(Object.entries(c.schema ?? {}).map(([k, col]) => [k, { name: col.name, type: col.type }]));
  return { version: c.version, name: c.name, schema };
}

export const JOURNAL_FILE = '.notion2md-journal.jsonl';

export function startJournal(path: string, root: string): void {
  writeFileSync(path, `${JSON.stringify({ root })}\n`);
}

export function appendEntry(path: string, entry: Entry): void {
  appendFileSync(path, `${JSON.stringify(entry)}\n`);
}

/**
 * Lines in order. A last line cut short by a kill is dropped, and nothing after it is trusted.
 * The file is split as bytes: a big crawl's journal is longer than the longest string V8 can hold.
 */
export function readJournal(path: string): Entry[] {
  const bytes = readFileSync(path);
  const entries: Entry[] = [];
  for (let start = 0; start < bytes.length; ) {
    let end = bytes.indexOf(10, start);
    if (end < 0) end = bytes.length;
    if (end > start) {
      try {
        entries.push(JSON.parse(bytes.toString('utf8', start, end)));
      } catch {
        break;
      }
    }
    start = end + 1;
  }
  return entries;
}
