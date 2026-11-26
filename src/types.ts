// Shapes of Notion's undocumented web API, only the fields this tool reads.
export type Run = [text: string, decos?: [tag: string, arg?: any][]];
export type RichText = Run[];

export interface Block {
  id: string;
  type: string;
  version?: number;
  created_time?: number;
  last_edited_time?: number;
  created_by_id?: string;
  created_by_table?: string;
  last_edited_by_id?: string;
  last_edited_by_table?: string;
  alive?: boolean;
  space_id?: string;
  content?: string[];
  properties?: Record<string, RichText>;
  format?: Record<string, any>;
  collection_id?: string;
  view_ids?: string[];
  parent_table?: string;
  parent_id?: string;
  discussions?: string[];
}

export interface Collection {
  version?: number;
  name?: RichText;
  schema?: Record<string, { name: string; type: string }>;
}

export interface Discussion {
  version?: number;
  parent_id?: string;
  resolved?: boolean;
  comments?: string[];
}

export interface Comment {
  version?: number;
  text?: RichText;
  created_time?: number;
  created_by_id?: string;
  created_by_table?: string;
  alive?: boolean;
}

export interface Store {
  blocks: Record<string, Block>;
  collections: Record<string, Collection>;
  /** Records absorbed since the last journal line, only set while a crawl is being journaled. */
  pending?: { blocks: Record<string, Block>; collections: Record<string, Collection> };
  discussions: Record<string, Discussion>;
  comments: Record<string, Comment>;
  /** Display names of mentioned people, by Notion user id. */
  users: Record<string, string>;
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
  discussion?: Record<string, Rec>;
  comment?: Record<string, Rec>;
  notion_user?: Record<string, Rec>;
  /** Automations and integrations: they can be the author of a row, and have no notion_user record. */
  bot?: Record<string, Rec>;
}

export interface ApiResponse {
  recordMap?: RecordMap;
  cursors?: Cursor[];
  cursor?: Cursor;
  result?: { reducerResults?: { collection_group_results?: { blockIds?: string[]; hasMore?: boolean } } };
}

export type Api = (endpoint: string, body: unknown) => Promise<ApiResponse>;
