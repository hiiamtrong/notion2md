import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { pageTitle, pageUrl, toMarkdown } from './markdown.ts';
import type { Store } from './types.ts';

const MAX_NAME = 80;
export const NO_ACCESS_FILE = '_no-access.md';
const LINKED_DIR = '_linked';

// Titles come from the page owner, so nothing here may escape the output dir or name a hidden file.
export function slug(title: string): string {
  const s = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, MAX_NAME)
    .replace(/^[.\s]+|[.\s]+$/g, '');
  return s || 'Untitled';
}

/**
 * page id -> posix path under the output dir: "Root.md", with what it contains in "Root/Sub.md".
 * Pages reached only through links sit flat in "_linked/": nesting them by who linked first builds folder chains
 * hundreds of characters long.
 */
export function layout(store: Store, rootId: string): Map<string, string> {
  const paths = new Map<string, string>();
  const taken = new Map<string, Set<string>>();
  const place = (id: string, dir: string) => {
    const names = taken.get(dir) ?? new Set<string>();
    taken.set(dir, names);
    let base = slug(pageTitle(store, id));
    // Case-insensitive on purpose: macOS and Windows would merge "A.md" and "a.md".
    if (names.has(base.toLowerCase())) base = `${base.slice(0, MAX_NAME - 9)}-${id.slice(0, 8)}`;
    names.add(base.toLowerCase());
    paths.set(id, posix.join(dir, `${base}.md`));
    for (const child of store.children.get(id) ?? []) if (store.expanded.has(child) && !paths.has(child)) place(child, posix.join(dir, base));
  };
  place(rootId, '');
  for (const id of store.expanded) if (!paths.has(id)) place(id, LINKED_DIR);
  return paths;
}

export function writeTree(store: Store, rootId: string, outDir: string): Map<string, string> {
  const paths = layout(store, rootId);
  for (const [id, path] of paths) {
    const from = posix.dirname(path);
    const href = (target: string) => {
      const to = paths.get(target);
      return to ? posix.relative(from, to).split('/').map(encodeURIComponent).join('/') : pageUrl(target);
    };
    const file = join(outDir, ...path.split('/'));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, toMarkdown(store, id, href));
  }
  if (store.noAccess.size) writeFileSync(join(outDir, NO_ACCESS_FILE), noAccessReport(store, paths));
  return paths;
}

function noAccessReport(store: Store, paths: Map<string, string>): string {
  const lines = ['# Pages without access', '', 'Notion refused these pages for the Chrome profile used, so they were skipped.', ''];
  for (const [id, from] of store.noAccess) {
    const fromPath = paths.get(from);
    const where = fromPath ? ` (linked from [${pageTitle(store, from) || 'Untitled'}](${fromPath.split('/').map(encodeURIComponent).join('/')}))` : '';
    lines.push(`- [${pageTitle(store, id) || id}](${pageUrl(id)})${where}`);
  }
  return `${lines.join('\n')}\n`;
}
