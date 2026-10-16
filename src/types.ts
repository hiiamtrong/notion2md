// Shapes of Notion's undocumented web API, only the fields this tool reads.
export type Run = [text: string, decos?: [tag: string, arg?: any][]];
export type RichText = Run[];

export interface Block {
  id: string;
  type: string;
  alive?: boolean;
  space_id?: string;
  content?: string[];
  properties?: Record<string, RichText>;
  format?: Record<string, any>;
  collection_id?: string;
  view_ids?: string[];
  parent_table?: string;
  parent_id?: string;
}

export interface Collection {
  name?: RichText;
  schema?: Record<string, { name: string; type: string }>;
}

export interface Store {
  blocks: Record<string, Block>;
  collections: Record<string, Collection>;
  expanded: Set<string>;
  children: Map<string, string[]>;
  rows: Map<string, string[]>;
  spaceId: string | undefined;
  gone: Set<string>;
  /** Pages Notion refused to give us, each mapped to the page that led to it. */
  noAccess: Map<string, string>;
  skipped: string[];
  truncated: 'max-pages' | 'aborted' | 'error' | undefined;
  error: string | undefined;
}

export interface Cursor {
  stack?: unknown[];
}

export interface Rec {
  spaceId?: string;
  value?: any;
}

export interface RecordMap {
  block?: Record<string, Rec>;
  collection?: Record<string, Rec>;
}

export interface ApiResponse {
  recordMap?: RecordMap;
  cursors?: Cursor[];
  cursor?: Cursor;
  result?: { reducerResults?: { collection_group_results?: { blockIds?: string[] } } };
}

export type Api = (endpoint: string, body: unknown) => Promise<ApiResponse>;
