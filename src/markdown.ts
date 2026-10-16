import { linkedPageId } from './notion.ts';
import type { Block, RichText, Store } from './types.ts';

const NOTION = 'https://www.notion.so/';
export const pageUrl = (id: string) => NOTION + id.replaceAll('-', '');
const NOTION_HOSTED = /^attachment:|secure\.notion-static\.com|prod-files-secure/;

type Doc = Pick<Store, 'blocks' | 'collections'> & { rows?: Store['rows'] };
type Href = (pageId: string) => string;

const collectionName = (id: string | undefined, store: Doc) => inlineText(id ? store.collections[id]?.name : undefined, store);

function inlineText(runs: RichText | undefined, store: Doc, href: Href = pageUrl): string {
  return (runs ?? []).map(([text, decos = []]) => {
    let s = text;
    let bold = false;
    let italic = false;
    let strike = false;
    let code = false;
    let link: string | undefined;
    for (const [tag, arg] of decos) {
      if (tag === 'b') bold = true;
      else if (tag === 'i') italic = true;
      else if (tag === 's') strike = true;
      else if (tag === 'c') code = true;
      else if (tag === 'a') {
        // A link to a page that was fetched becomes a link to its file; any other link stays as written.
        const id = linkedPageId(arg);
        const local = id && href(id) !== pageUrl(id) ? href(id) : undefined;
        link = local ?? (arg.startsWith('/') ? NOTION + arg.slice(1) : arg);
      }
      else if (tag === 'e') return `$${arg}$`;
      else if (tag === 'd') s = arg.end_date ? `${arg.start_date} to ${arg.end_date}` : arg.start_date;
      else if (tag === 'u') s = '@user';
      else if (tag === 'p') {
        const target = store.blocks[arg];
        link = href(arg);
        s = inlineText(target?.properties?.title, store) || collectionName(target?.collection_id, store) || 'page';
      }
    }
    const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(s)!;
    if (!core) return s;
    let out = core;
    if (code) out = `\`${out}\``;
    else {
      if (bold) out = `**${out}**`;
      if (italic) out = `*${out}*`;
      if (strike) out = `~~${out}~~`;
    }
    if (link) out = `[${out}](${link})`;
    return lead + out + trail;
  }).join('');
}

const HEADINGS = { header: '##', sub_header: '###', sub_sub_header: '####' };

export function toMarkdown(store: Doc, rootId: string, hrefOf: Href = pageUrl): string {
  const { blocks } = store;
  const text = (b: Block, key = 'title') => inlineText(b.properties?.[key], store, hrefOf);
  const plain = (b: Block, key: string) => (b.properties?.[key] ?? []).map((r) => r[0]).join('');

  // Rows of a database carry their fields (Status, Owner, ...) as properties named by the collection schema.
  function rowProperties(b: Block): string[] {
    const schema = b.parent_table === 'collection' && b.parent_id ? store.collections[b.parent_id]?.schema : undefined;
    return Object.entries(schema ?? {})
      .filter(([, col]) => col.type !== 'title')
      .map(([key, col]) => [col.name, text(b, key).trim()] as const)
      .filter(([, value]) => value)
      .map(([name, value]) => `- **${name}:** ${value}`);
  }

  function children(ids: string[] = [], indent: number): string[] {
    const lines: string[] = [];
    let n = 0;
    let prev: string | undefined;
    for (const id of ids) {
      const b = blocks[id];
      if (!b || b.alive === false) continue;
      n = b.type === 'numbered_list' ? (prev === 'numbered_list' ? n + 1 : 1) : 0;
      lines.push(...block(b, indent, n));
      prev = b.type;
    }
    return lines;
  }

  function block(b: Block, indent: number, n: number): string[] {
    const pad = '    '.repeat(indent);
    const title = text(b);
    const kids = (i = indent) => children(b.content, i);
    const para = (...ls: string[]) => ['', ...ls, ''];
    const quote = (first: string) => {
      const inner = [first, ...kids(0)].filter((l, i, all) => l !== '' || (i > 0 && all[i - 1] !== ''));
      while (inner[0] === '') inner.shift();
      while (inner.at(-1) === '') inner.pop();
      return para(...inner.map((l) => `${pad}${l ? `> ${l}` : '>'}`));
    };

    switch (b.type) {
      case 'page':
        if (b.id === rootId) {
          const props = rowProperties(b);
          return [`# ${title}`, '', ...(props.length ? [...props, ''] : []), ...kids(0)];
        }
        return para(`${pad}[${title || 'Untitled'}](${hrefOf(b.id)})`);
      case 'header': case 'sub_header': case 'sub_sub_header':
        return [...para(`${pad}${HEADINGS[b.type]} ${title}`), ...kids()];
      case 'text':
        return [...para(`${pad}${title}`), ...kids()];
      case 'bulleted_list':
        return [`${pad}- ${title}`, ...kids(indent + 1)];
      case 'numbered_list':
        return [`${pad}${n}. ${title}`, ...kids(indent + 1)];
      case 'to_do':
        return [`${pad}- [${plain(b, 'checked') === 'Yes' ? 'x' : ' '}] ${title}`, ...kids(indent + 1)];
      case 'toggle':
        return [`${pad}- ${title}`, ...kids(indent + 1)];
      case 'quote':
        return quote(title);
      case 'callout': {
        const icon = b.format?.page_icon;
        return quote(`${icon && !icon.startsWith('/') && !icon.startsWith('http') ? `${icon} ` : ''}${title}`);
      }
      case 'divider':
        return para(`${pad}---`);
      case 'code': {
        const code = plain(b, 'title');
        const fence = '`'.repeat(Math.max(3, ...(code.match(/`+/g) ?? []).map((m) => m.length + 1)));
        const lang = plain(b, 'language').toLowerCase();
        return para(`${pad}${fence}${lang === 'plain text' ? '' : lang}`, ...code.split('\n').map((l) => pad + l), `${pad}${fence}`);
      }
      case 'equation':
        return para(`${pad}$$${plain(b, 'title')}$$`);
      case 'image': {
        const src = plain(b, 'source');
        const url = NOTION_HOSTED.test(src) ? `${NOTION}image/${encodeURIComponent(src)}?table=block&id=${b.id}&cache=v2` : src;
        return src ? para(`${pad}![${text(b, 'caption')}](${url})`) : [];
      }
      case 'bookmark': case 'video': case 'embed': case 'file': case 'pdf': case 'audio': {
        const url = plain(b, 'source') || plain(b, 'link');
        return url ? para(`${pad}[${plain(b, 'title') || text(b, 'caption') || url}](${url})`) : [];
      }
      case 'table': {
        const cols: string[] = b.format?.table_block_column_order ?? [];
        const rows = (b.content ?? []).map((id) => blocks[id]).filter((r): r is Block => !!r)
          .map((r) => cols.map((c) => inlineText(r.properties?.[c], store, hrefOf).replaceAll('|', '\\|').replaceAll('\n', '<br>')));
        if (!rows.length) return [];
        const row = (cells: string[]) => `${pad}| ${cells.join(' | ')} |`;
        const [head, body] = b.format?.table_block_column_header ? [rows[0], rows.slice(1)] : [cols.map(() => ''), rows];
        return para(row(head), row(cols.map(() => '---')), ...body.map(row));
      }
      case 'collection_view': case 'collection_view_page': {
        const name = collectionName(b.collection_id, store) || title || 'Database';
        if (b.id !== rootId) return para(`${pad}[Database: ${name}](${hrefOf(b.id)})`);
        const rows = (store.rows?.get(b.id) ?? []).map((id) => blocks[id]).filter((r): r is Block => !!r);
        return [`# ${name}`, '', ...rows.map((r) => `- [${text(r) || 'Untitled'}](${hrefOf(r.id)})`)];
      }
      case 'alias': {
        const target = b.format?.alias_pointer?.id;
        return target ? para(`${pad}[${text(blocks[target] ?? {}) || 'Linked page'}](${hrefOf(target)})`) : [];
      }
      case 'table_of_contents': case 'breadcrumb': case 'table_row':
        return [];
      default:
        return [...(title ? para(`${pad}${title}`) : []), ...kids()];
    }
  }

  const lines = block(blocks[rootId]!, 0, 0);
  const out: string[] = [];
  for (const l of lines) if (l.trim() || (out.length && out.at(-1)!.trim())) out.push(l.trimEnd());
  return `${out.join('\n').trim()}\n`;
}

export const pageTitle = (store: Doc, id: string) => {
  const b = store.blocks[id];
  return inlineText(b?.properties?.title, store) || collectionName(b?.collection_id, store);
};
