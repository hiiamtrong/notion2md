import { CliError } from './errors.ts';
import { pageUrl, pageTitle } from './markdown.ts';
import type { Api, Block, Collection } from './types.ts';

export interface Where {
  name: string;
  value: string;
}

export interface FoundRow {
  id: string;
  title: string;
  url: string;
}

interface PropertySchema {
  name: string;
  type: string;
  options?: { value: string }[];
}

export type Schema = Record<string, PropertySchema>;

export function parseWheres(list: string[]): Where[] {
  return list.map((w) => {
    const i = w.indexOf('=');
    if (i < 1) throw new CliError('BAD_INPUT', `--where must look like "Name=value", got "${w}"`, undefined, 2);
    return { name: w.slice(0, i).trim(), value: w.slice(i + 1).trim() };
  });
}

export function parseLimit(v: string | undefined): number {
  if (v === undefined) return 20;
  if (!/^[1-9]\d*$/.test(v)) throw new CliError('BAD_INPUT', `--limit must be a positive integer, got "${v}"`, undefined, 2);
  return Number(v);
}

// A select/status filter that names no real option matches nothing, so a typo would look like an empty result.
function option(options: { value: string }[] | undefined, value: string, name: string): string {
  const hit = options?.find((o) => o.value.toLowerCase() === value.toLowerCase());
  if (!options?.length || hit) return hit?.value ?? value;
  throw new CliError('BAD_INPUT', `"${value}" is not an option of the "${name}" property`, `Options: ${options.map((o) => o.value).join(', ')}`, 2);
}

function filterFor(property: PropertySchema, value: string): Record<string, unknown> {
  switch (property.type) {
    case 'title':
    case 'text':
      return { operator: 'string_contains', value: { type: 'exact', value } };
    case 'number':
    case 'auto_increment_id': {
      const n = Number(value);
      if (!value || Number.isNaN(n)) throw new CliError('BAD_INPUT', `The "${property.name}" property holds numbers, got "${value}"`, undefined, 2);
      return { operator: 'number_equals', value: { type: 'exact', value: n } };
    }
    case 'select':
      return { operator: 'enum_is', value: { type: 'exact', value: option(property.options, value, property.name) } };
    case 'multi_select':
      return { operator: 'enum_contains', value: { type: 'exact', value: option(property.options, value, property.name) } };
    case 'status':
      return { operator: 'status_is', value: { type: 'is_option', value: option(property.options, value, property.name) } };
    default:
      // date, person and relation filters take an id or a range, not the text a user types here.
      throw new CliError('BAD_INPUT', `Cannot look up the ${property.type} property "${property.name}"`, 'This works on title, text, number, Task ID, select, multi_select and status properties', 2);
  }
}

export interface Filter {
  operator: 'and';
  filters: { property: string; filter: Record<string, unknown> }[];
}

/** A Notion filter matching every "--where Name=value", by property name rather than by the internal id. */
export function buildFilter(schema: Schema, wheres: Where[]): Filter {
  const properties = Object.entries(schema).map(([id, p]) => ({ id, ...p }));
  const byName = new Map(properties.map((p) => [p.name.toLowerCase(), p]));
  const filters = wheres.map(({ name, value }) => {
    const property = byName.get(name.toLowerCase());
    if (!property) {
      const names = properties.map((p) => p.name).sort();
      throw new CliError('BAD_INPUT', `The database has no property named "${name}"`, names.length ? `Properties: ${names.slice(0, 15).join(', ')}${names.length > 15 ? `, and ${names.length - 15} more` : ''}` : 'The database has no properties yet', 2);
    }
    return { property: property.id, filter: filterFor(property, value) };
  });
  return { operator: 'and', filters };
}

// Current shape is {value:{value:block}}, older responses are {value:block}.
const unwrap = (rec: { value?: any } | undefined) => rec?.value?.value ?? rec?.value;

export interface FindOptions {
  wheres: Where[];
  limit: number;
}

export interface FindResult {
  database: { id: string; title: string; url: string };
  rows: FoundRow[];
  hasMore: boolean;
}

/** Rows of one database that match every filter, newest view order, capped at `limit`. */
export async function findRows(api: Api, dbId: string, o: FindOptions): Promise<FindResult> {
  const opened = await api('loadCachedPageChunkV2', { page: { id: dbId }, limit: 1, cursor: { stack: [] }, chunkNumber: 0, verticalColumns: false });
  const record = opened.recordMap?.block?.[dbId];
  const db: Block | undefined = unwrap(record);
  if (!db) throw new CliError('NO_ACCESS', `Page ${dbId} not returned by Notion`, 'The page is private to another account, deleted, or this Chrome profile is not logged in to Notion', 4);
  const collectionId = db.collection_id;
  const view = db.view_ids?.[0];
  if (!collectionId || !view) throw new CliError('BAD_INPUT', `${dbId} is a page, not a database`, 'Pass the URL of a database page, like the one listing the rows', 2);
  const spaceId: string | undefined = record?.spaceId ?? db.space_id;
  if (!spaceId) throw new CliError('API_ERROR', `Notion did not say which workspace ${dbId} belongs to`, undefined, 1);
  const collection: Collection | undefined = unwrap(opened.recordMap?.collection?.[collectionId]);
  if (!collection?.schema) throw new CliError('API_ERROR', `Notion did not return the database behind ${dbId}`, undefined, 1);

  const found = await api('queryCollection', {
    collection: { id: collectionId, spaceId },
    collectionView: { id: view, spaceId },
    source: { type: 'collection', id: collectionId, spaceId },
    loader: {
      type: 'reducer',
      sort: [],
      searchQuery: '',
      userTimeZone: 'UTC',
      reducers: { collection_group_results: { type: 'results', limit: o.limit, filter: buildFilter(collection.schema, o.wheres) } },
    },
  });

  const blocks: Record<string, Block> = {};
  for (const [id, rec] of Object.entries({ ...opened.recordMap?.block, ...found.recordMap?.block })) {
    const b: Block | undefined = unwrap(rec);
    if (b) blocks[id] = b;
  }
  const collections: Record<string, Collection> = {};
  for (const [id, rec] of Object.entries({ ...opened.recordMap?.collection, ...found.recordMap?.collection })) {
    const c: Collection | undefined = unwrap(rec);
    if (c) collections[id] = c;
  }
  const group = found.result?.reducerResults?.collection_group_results;
  const doc = { blocks, collections };
  return {
    database: { id: dbId, title: pageTitle(doc, dbId), url: pageUrl(dbId) },
    rows: (group?.blockIds ?? []).filter((id) => blocks[id]?.alive !== false).map((id) => ({ id, title: pageTitle(doc, id), url: pageUrl(id) })),
    hasMore: group?.hasMore ?? false,
  };
}
