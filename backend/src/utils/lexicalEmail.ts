/**
 * Turn submission content (Lexical editor JSON, or legacy HTML / plain text) into an
 * email-safe HTML fragment and a plain-text alternative.
 *
 * No DOM: a recursive serializer over the serialized Lexical JSON. Email clients ignore
 * <style> blocks, so every style is inline. All text and attribute values are escaped, and
 * only http(s)/mailto/tel links and http(s) images are emitted. Relative URLs (the gallery
 * stores `/api/gallery/<file>`) are made absolute against PUBLIC_URL's origin.
 *
 * Node types handled: root, paragraph, heading, quote, list / listitem (bullet, number,
 * check; nested), text (format bits), linebreak, tab, link / autolink, table / tablerow /
 * tablecell, code / code-highlight, horizontalrule, image (custom ImageNode), checkbox
 * (custom CheckboxNode), suggestion (custom SuggestionNode), inserted-text. Deletion
 * markers (`deleted-text`) are pending deletions and are left out. Unknown element nodes
 * render their children; unknown leaf nodes with a `text` render it as text.
 */

/** The widest an image may be: the email's content column. */
export const EMAIL_MAX_IMAGE_WIDTH = 600;

export const EMAIL_FONT_FAMILY = 'Calibri, Arial, Helvetica, sans-serif';

export interface RenderOptions {
  /** PUBLIC_URL (e.g. https://scrivenly.com/api); its origin makes relative URLs absolute. */
  publicUrl?: string;
}

export interface RenderedEmailBody {
  html: string;
  text: string;
}

// Lexical text format bits (lexical/src/LexicalConstants.ts)
export const TEXT_FORMAT = {
  bold: 1,
  italic: 2,
  strikethrough: 4,
  underline: 8,
  code: 16,
  subscript: 32,
  superscript: 64,
  highlight: 128,
} as const;

type LexicalNode = { type?: string; children?: LexicalNode[]; [key: string]: any };

const BLOCK_MARGIN = 'margin:0;';
const LINK_STYLE = 'color:#1a5fb4;text-decoration:underline;';
const CODE_INLINE_STYLE = "font-family:Consolas,'Courier New',monospace;background-color:#f2f2f2;padding:0 2px;";
const CODE_BLOCK_STYLE = "font-family:Consolas,'Courier New',monospace;font-size:13px;line-height:1.4;background-color:#f5f5f5;border:1px solid #e0e0e0;padding:8px 12px;margin:0 0 8px 0;white-space:pre-wrap;word-wrap:break-word;";
const QUOTE_STYLE = 'margin:0 0 8px 0;padding:0 0 0 12px;border-left:4px solid #cccccc;color:#555555;';
const HEADING_SIZES: Record<string, string> = {
  h1: '26px', h2: '22px', h3: '19px', h4: '17px', h5: '15px', h6: '14px',
};
const TABLE_STYLE = 'border-collapse:collapse;margin:0 0 8px 0;';
const CELL_STYLE = 'border:1px solid #cccccc;padding:6px 8px;vertical-align:top;text-align:left;';

// ---------------------------------------------------------------------------
// Escaping and URLs
// ---------------------------------------------------------------------------

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function originOf(publicUrl: string | undefined): string | null {
  if (!publicUrl) return null;
  try {
    return new URL(publicUrl).origin;
  } catch {
    return null;
  }
}

/**
 * An absolute URL safe to put in an email, or null. Root-relative URLs (`/api/gallery/...`)
 * resolve against the PUBLIC_URL origin. `allowed` lists the schemes accepted.
 */
export function safeUrl(raw: unknown, allowed: string[], publicUrl: string | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;
  let resolved: URL;
  try {
    if (value.startsWith('/') && !value.startsWith('//')) {
      const origin = originOf(publicUrl);
      if (!origin) return null;
      resolved = new URL(value, origin);
    } else {
      resolved = new URL(value);
    }
  } catch {
    return null;
  }
  if (!allowed.includes(resolved.protocol)) return null;
  return resolved.href;
}

const LINK_SCHEMES = ['http:', 'https:', 'mailto:', 'tel:'];
const IMAGE_SCHEMES = ['http:', 'https:'];

// Inline text styles kept from the editor (pasted colours, sizes). Anything else is dropped.
const KEPT_STYLE_PROPERTIES = new Set(['color', 'background-color', 'font-size']);
const SAFE_STYLE_VALUE = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|[a-z]+|\d+(\.\d+)?(px|pt|em|rem|%))$/i;

function safeTextStyle(style: unknown): string {
  if (typeof style !== 'string' || !style) return '';
  const kept: string[] = [];
  for (const declaration of style.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon < 0) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim();
    if (KEPT_STYLE_PROPERTIES.has(property) && SAFE_STYLE_VALUE.test(value)) {
      kept.push(`${property}:${value}`);
    }
  }
  return kept.length ? kept.join(';') + ';' : '';
}

/** Block alignment and indent from an element node's `format` / `indent`. */
function blockStyle(node: LexicalNode, withIndent = true): string {
  let style = '';
  const format = node.format;
  if (typeof format === 'string' && ['left', 'center', 'right', 'justify'].includes(format)) {
    style += `text-align:${format};`;
  } else if (format === 'start') {
    style += 'text-align:left;';
  } else if (format === 'end') {
    style += 'text-align:right;';
  }
  const indent = Number(node.indent);
  if (withIndent && Number.isFinite(indent) && indent > 0) {
    style += `padding-left:${Math.min(indent, 10) * 40}px;`;
  }
  return style;
}

// ---------------------------------------------------------------------------
// Lexical detection
// ---------------------------------------------------------------------------

/** The parsed Lexical state when `content` is Lexical JSON, else null. */
export function parseLexical(content: unknown): { root: LexicalNode } | null {
  let value: any = content;
  if (typeof content === 'string') {
    const trimmed = content.trim();
    if (!trimmed.startsWith('{')) return null;
    try {
      value = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (value && typeof value === 'object') {
    // Some callers wrap the state: { editorState: { root } }
    if (value.editorState && typeof value.editorState === 'object' && value.editorState.root) {
      value = value.editorState;
    }
    if (value.root && typeof value.root === 'object' && Array.isArray(value.root.children)) {
      return value as { root: LexicalNode };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// HTML serializer
// ---------------------------------------------------------------------------

interface HtmlContext {
  publicUrl?: string;
  /** Inside a code block: linebreaks are newlines, text is not formatted. */
  inCode?: boolean;
}

function childrenOf(node: LexicalNode): LexicalNode[] {
  return Array.isArray(node.children) ? node.children.filter((c) => c && typeof c === 'object') : [];
}

function renderChildrenHtml(node: LexicalNode, ctx: HtmlContext): string {
  return childrenOf(node).map((child) => renderNodeHtml(child, ctx)).join('');
}

/**
 * The inline content of a block. A trailing linebreak needs an extra <br>, as Lexical's own
 * DOM adds one, or browsers collapse it. An empty block keeps its line with &nbsp;.
 */
function renderInlineContent(node: LexicalNode, ctx: HtmlContext): string {
  const children = childrenOf(node);
  const inner = renderChildrenHtml(node, ctx);
  if (!inner) return '&nbsp;';
  const last = children[children.length - 1];
  return last && last.type === 'linebreak' ? inner + '<br>' : inner;
}

function renderTextHtml(text: string, format: number, style: string, ctx: HtmlContext): string {
  let html = escapeHtml(text);
  if (ctx.inCode) return html;
  // The tab character renders as spaces in most clients only inside <pre>
  html = html.replace(/\t/g, '&nbsp;&nbsp;&nbsp;&nbsp;');
  if (format & TEXT_FORMAT.code) html = `<code style="${CODE_INLINE_STYLE}">${html}</code>`;
  if (format & TEXT_FORMAT.bold) html = `<strong>${html}</strong>`;
  if (format & TEXT_FORMAT.italic) html = `<em>${html}</em>`;
  if (format & TEXT_FORMAT.underline) html = `<u>${html}</u>`;
  if (format & TEXT_FORMAT.strikethrough) html = `<s>${html}</s>`;
  if (format & TEXT_FORMAT.subscript) html = `<sub>${html}</sub>`;
  if (format & TEXT_FORMAT.superscript) html = `<sup>${html}</sup>`;
  if (format & TEXT_FORMAT.highlight) html = `<span style="background-color:#fff3a3;">${html}</span>`;
  const kept = safeTextStyle(style);
  if (kept) html = `<span style="${escapeHtml(kept)}">${html}</span>`;
  return html;
}

function imageWidth(node: LexicalNode): number | null {
  const raw = node.width;
  const width = typeof raw === 'number' ? raw : typeof raw === 'string' ? parseFloat(raw) : NaN;
  if (!Number.isFinite(width) || width <= 0) return null;
  return Math.round(Math.min(width, EMAIL_MAX_IMAGE_WIDTH));
}

function renderImageHtml(node: LexicalNode, ctx: HtmlContext): string {
  if (node.pending) return ''; // an import placeholder, never content
  const src = safeUrl(node.src, IMAGE_SCHEMES, ctx.publicUrl)
    || safeUrl(node.fullSizeSrc, IMAGE_SCHEMES, ctx.publicUrl);
  if (!src) return '';
  const width = imageWidth(node);
  const alt = escapeHtml(node.altText || '');
  const widthAttr = width ? ` width="${width}"` : '';
  const imgStyle = `display:block;border:0;outline:none;max-width:100%;height:auto;${width ? `width:${width}px;` : `width:auto;`}`;
  const alignment = node.alignment;
  let margin = 'margin:0;';
  let wrapperAlign = 'left';
  if (alignment === 'center') {
    margin = 'margin:0 auto;';
    wrapperAlign = 'center';
  } else if (alignment === 'right') {
    margin = 'margin:0 0 0 auto;';
    wrapperAlign = 'right';
  }
  const img = `<img src="${escapeHtml(src)}" alt="${alt}"${widthAttr} style="${imgStyle}${margin}">`;
  return `<div style="margin:0 0 8px 0;text-align:${wrapperAlign};">${img}</div>`;
}

function renderListHtml(node: LexicalNode, ctx: HtmlContext): string {
  const listType = node.listType || (node.tag === 'ol' ? 'number' : 'bullet');
  const isNumber = listType === 'number';
  const tag = isNumber ? 'ol' : 'ul';
  const start = Number(node.start);
  const startAttr = isNumber && Number.isFinite(start) && start > 1 ? ` start="${Math.floor(start)}"` : '';
  const listStyle = listType === 'check' ? 'list-style-type:none;padding-left:8px;' : 'padding-left:28px;';
  const items = childrenOf(node).map((child) => {
    if (child.type !== 'listitem') return renderNodeHtml(child, ctx);
    return renderListItemHtml(child, ctx, listType);
  }).join('');
  return `<${tag}${startAttr} style="margin:0 0 4px 0;${listStyle}">${items}</${tag}>`;
}

function renderListItemHtml(node: LexicalNode, ctx: HtmlContext, listType: string): string {
  const children = childrenOf(node);
  // A listitem holding only a nested list is Lexical's nesting wrapper: no bullet of its own
  if (children.length > 0 && children.every((c) => c.type === 'list')) {
    return `<li style="list-style-type:none;margin:0;">${renderChildrenHtml(node, ctx)}</li>`;
  }
  let prefix = '';
  if (listType === 'check') {
    prefix = node.checked ? '&#9745;&nbsp;' : '&#9744;&nbsp;';
  }
  const align = blockStyle(node, false);
  return `<li style="margin:0 0 2px 0;${align}">${prefix}${renderInlineContent(node, ctx)}</li>`;
}

function renderTableHtml(node: LexicalNode, ctx: HtmlContext): string {
  const rows = childrenOf(node).map((row) => {
    if (row.type !== 'tablerow') return renderNodeHtml(row, ctx);
    const cells = childrenOf(row).map((cell) => {
      if (cell.type !== 'tablecell') return renderNodeHtml(cell, ctx);
      const isHeader = Number(cell.headerState) > 0;
      const tag = isHeader ? 'th' : 'td';
      const colSpan = Number(cell.colSpan);
      const rowSpan = Number(cell.rowSpan);
      const spans = (Number.isFinite(colSpan) && colSpan > 1 ? ` colspan="${Math.floor(colSpan)}"` : '')
        + (Number.isFinite(rowSpan) && rowSpan > 1 ? ` rowspan="${Math.floor(rowSpan)}"` : '');
      const background = typeof cell.backgroundColor === 'string' && SAFE_STYLE_VALUE.test(cell.backgroundColor)
        ? `background-color:${cell.backgroundColor};`
        : isHeader ? 'background-color:#f2f2f2;' : '';
      const weight = isHeader ? 'font-weight:bold;' : '';
      return `<${tag}${spans} style="${CELL_STYLE}${background}${weight}">${renderChildrenHtml(cell, ctx) || '&nbsp;'}</${tag}>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }).join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="${TABLE_STYLE}"><tbody>${rows}</tbody></table>`;
}

function renderNodeHtml(node: LexicalNode, ctx: HtmlContext): string {
  switch (node.type) {
    case 'root':
      return renderChildrenHtml(node, ctx);
    case 'paragraph':
      return `<p style="${BLOCK_MARGIN}${blockStyle(node)}">${renderInlineContent(node, ctx)}</p>`;
    case 'heading': {
      const tag = typeof node.tag === 'string' && /^h[1-6]$/.test(node.tag) ? node.tag : 'h2';
      return `<${tag} style="margin:12px 0 6px 0;font-family:${EMAIL_FONT_FAMILY};font-size:${HEADING_SIZES[tag]};line-height:1.25;font-weight:bold;${blockStyle(node)}">${renderInlineContent(node, ctx)}</${tag}>`;
    }
    case 'quote':
      return `<blockquote style="${QUOTE_STYLE}${blockStyle(node, false)}">${renderInlineContent(node, ctx)}</blockquote>`;
    case 'list':
      return renderListHtml(node, ctx);
    case 'listitem':
      // A listitem outside a list: render as a bullet list of one
      return `<ul style="margin:0 0 4px 0;padding-left:28px;">${renderListItemHtml(node, ctx, 'bullet')}</ul>`;
    case 'code':
      return `<pre style="${CODE_BLOCK_STYLE}">${renderChildrenHtml(node, { ...ctx, inCode: true })}</pre>`;
    case 'text':
    case 'code-highlight':
    case 'hashtag':
    case 'inserted-text':
      return renderTextHtml(String(node.text ?? node.insertedText ?? ''), Number(node.format) || 0, node.style, ctx);
    case 'tab':
      return ctx.inCode ? '\t' : '&nbsp;&nbsp;&nbsp;&nbsp;';
    case 'linebreak':
      return ctx.inCode ? '\n' : '<br>';
    case 'link':
    case 'autolink': {
      const inner = renderChildrenHtml(node, ctx);
      const href = safeUrl(node.url, LINK_SCHEMES, ctx.publicUrl);
      if (!href) return inner;
      const title = typeof node.title === 'string' && node.title ? ` title="${escapeHtml(node.title)}"` : '';
      return `<a href="${escapeHtml(href)}"${title} style="${LINK_STYLE}">${inner || escapeHtml(href)}</a>`;
    }
    case 'table':
      return renderTableHtml(node, ctx);
    case 'tablerow':
      return `<table role="presentation" style="${TABLE_STYLE}"><tbody>${renderTableRowFallback(node, ctx)}</tbody></table>`;
    case 'tablecell':
      return `<div>${renderChildrenHtml(node, ctx)}</div>`;
    case 'horizontalrule':
      return '<hr style="border:0;border-top:1px solid #cccccc;margin:12px 0;">';
    case 'image':
      return renderImageHtml(node, ctx);
    case 'checkbox': {
      const box = node.checked ? '&#9745;' : '&#9744;';
      const label = renderChildrenHtml(node, ctx) || escapeHtml(node.text || '');
      return `<p style="${BLOCK_MARGIN}">${box}&nbsp;${label}</p>`;
    }
    case 'suggestion':
      // An approved suggestion is part of the text; a pending or rejected one is not yet
      return renderTextHtml(String(node.status === 'APPROVED' ? node.suggestedText ?? '' : node.originalText ?? ''), 0, '', ctx);
    case 'deleted-text':
      return ''; // a pending deletion: the text is going away
    default:
      if (Array.isArray(node.children)) return renderChildrenHtml(node, ctx);
      if (typeof node.text === 'string') return renderTextHtml(node.text, Number(node.format) || 0, node.style, ctx);
      return '';
  }
}

function renderTableRowFallback(node: LexicalNode, ctx: HtmlContext): string {
  return `<tr>${childrenOf(node).map((cell) => `<td style="${CELL_STYLE}">${renderChildrenHtml(cell, ctx)}</td>`).join('')}</tr>`;
}

// ---------------------------------------------------------------------------
// Plain-text serializer
// ---------------------------------------------------------------------------

interface TextContext {
  publicUrl?: string;
  listDepth: number;
}

function inlineText(node: LexicalNode, ctx: TextContext): string {
  return childrenOf(node).map((child) => nodeText(child, ctx)).join('');
}

function listText(node: LexicalNode, ctx: TextContext): string {
  const listType = node.listType || (node.tag === 'ol' ? 'number' : 'bullet');
  const start = Number(node.start);
  let number = Number.isFinite(start) && start > 0 ? Math.floor(start) : 1;
  const indent = '  '.repeat(ctx.listDepth);
  const lines: string[] = [];
  for (const item of childrenOf(node)) {
    const itemChildren = childrenOf(item);
    if (item.type === 'listitem' && itemChildren.length > 0 && itemChildren.every((c) => c.type === 'list')) {
      for (const nested of itemChildren) {
        lines.push(listText(nested, { ...ctx, listDepth: ctx.listDepth + 1 }).replace(/\n$/, ''));
      }
      continue;
    }
    let marker = '- ';
    if (listType === 'number') marker = `${number++}. `;
    else if (listType === 'check') marker = item.checked ? '[x] ' : '[ ] ';
    const body = inlineText(item, ctx).replace(/\n+$/, '');
    // Continuation lines line up under the item's text
    lines.push(indent + marker + body.replace(/\n/g, '\n' + indent + ' '.repeat(marker.length)));
  }
  return lines.join('\n') + '\n';
}

function nodeText(node: LexicalNode, ctx: TextContext): string {
  switch (node.type) {
    case 'root':
      return childrenOf(node).map((child) => nodeText(child, ctx)).join('');
    case 'paragraph':
    case 'heading':
      return inlineText(node, ctx) + '\n';
    case 'quote':
      return inlineText(node, ctx).split('\n').map((line) => `> ${line}`).join('\n') + '\n';
    case 'list':
      return listText(node, ctx);
    case 'listitem':
      return '- ' + inlineText(node, ctx) + '\n';
    case 'code':
      return inlineText(node, ctx) + '\n';
    case 'text':
    case 'code-highlight':
    case 'hashtag':
    case 'inserted-text':
      return String(node.text ?? node.insertedText ?? '');
    case 'tab':
      return '\t';
    case 'linebreak':
      return '\n';
    case 'link':
    case 'autolink': {
      const label = inlineText(node, ctx);
      const href = safeUrl(node.url, LINK_SCHEMES, ctx.publicUrl);
      if (!href) return label;
      const shown = href.replace(/^mailto:/, '');
      return label.trim() && label.trim() !== shown && label.trim() !== href ? `${label} (${shown})` : (label || shown);
    }
    case 'table':
      return childrenOf(node).map((row) =>
        childrenOf(row).map((cell) => inlineCellText(cell, ctx)).join(' | ')
      ).join('\n') + '\n';
    case 'horizontalrule':
      return '----------\n';
    case 'image': {
      if (node.pending) return '';
      const src = safeUrl(node.src, IMAGE_SCHEMES, ctx.publicUrl);
      if (!src) return '';
      return `[Image${node.altText ? `: ${node.altText}` : ''}]\n`;
    }
    case 'checkbox':
      return `${node.checked ? '[x]' : '[ ]'} ${inlineText(node, ctx) || node.text || ''}\n`;
    case 'suggestion':
      return String(node.status === 'APPROVED' ? node.suggestedText ?? '' : node.originalText ?? '');
    case 'deleted-text':
      return '';
    default:
      if (Array.isArray(node.children)) return inlineText(node, ctx);
      if (typeof node.text === 'string') return node.text;
      return '';
  }
}

function inlineCellText(cell: LexicalNode, ctx: TextContext): string {
  return childrenOf(cell).map((child) => nodeText(child, ctx)).join(' ').replace(/\s*\n\s*/g, ' ').trim();
}

/** Tidy a plain-text body: no trailing spaces, at most one blank line in a row. */
function tidyText(text: string): string {
  return text
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\s+$/, '');
}

// ---------------------------------------------------------------------------
// Non-Lexical content
// ---------------------------------------------------------------------------

const LOOKS_LIKE_HTML = /<(p|div|br|span|a|img|ul|ol|li|h[1-6]|table|strong|b|em|i|u|blockquote|pre)\b[^>]*>/i;

// Legacy HTML is rebuilt from allow-lists: other tags are dropped (their text kept), other
// attributes are dropped, href/src must be safe URLs, and stray `<` / `>` are escaped.
const LEGACY_DROPPED_BLOCKS = /<(script|style|iframe|object|embed|applet|form|noscript|template|svg|math|textarea|select|title|head)\b[\s\S]*?<\/\1\s*>/gi;
const LEGACY_TAGS = new Set([
  'p', 'div', 'span', 'br', 'a', 'img', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col',
  'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'sub', 'sup', 'small', 'big', 'font', 'center',
  'blockquote', 'pre', 'code', 'hr',
]);
const LEGACY_ATTRIBUTES = new Set([
  'href', 'src', 'alt', 'title', 'width', 'height', 'style', 'align', 'valign', 'border',
  'cellpadding', 'cellspacing', 'colspan', 'rowspan', 'bgcolor', 'color', 'face', 'size', 'start',
]);
const LEGACY_TOKEN = /(<!--[\s\S]*?-->|<\/?[a-zA-Z][\w-]*(?:\s[^<>]*)?\/?>)/g;
const LEGACY_ATTRIBUTE = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function sanitizeLegacyTag(tag: string, publicUrl: string | undefined): string {
  if (tag.startsWith('<!--')) return '';
  const match = /^<(\/?)([a-zA-Z][\w-]*)([\s\S]*?)\/?>$/.exec(tag);
  if (!match) return '';
  const [, closing, rawName, rawAttributes] = match;
  const name = rawName.toLowerCase();
  if (!LEGACY_TAGS.has(name)) return '';
  if (closing) return `</${name}>`;
  const attributes: string[] = [];
  LEGACY_ATTRIBUTE.lastIndex = 0;
  let attribute: RegExpExecArray | null;
  while ((attribute = LEGACY_ATTRIBUTE.exec(rawAttributes)) !== null) {
    const attr = attribute[1].toLowerCase();
    if (!LEGACY_ATTRIBUTES.has(attr)) continue;
    const value = decodeEntities(attribute[2] ?? attribute[3] ?? attribute[4] ?? '');
    if (attr === 'href' || attr === 'src') {
      const url = safeUrl(value, attr === 'src' ? IMAGE_SCHEMES : LINK_SCHEMES, publicUrl);
      if (url) attributes.push(` ${attr}="${escapeHtml(url)}"`);
      continue;
    }
    if (attr === 'style' && /expression|url\s*\(|javascript:|behavior|@import|\\/i.test(value)) continue;
    attributes.push(` ${attr}="${escapeHtml(value)}"`);
  }
  return `<${name}${attributes.join('')}>`;
}

/**
 * Legacy HTML content, made safe enough to send: allow-listed tags and attributes only (no
 * scripts, frames, forms, SVG, event handlers or styles that load things), href/src limited
 * to http(s)/mailto/tel and made absolute, and text outside tags escaped.
 */
function sanitizeLegacyHtml(html: string, publicUrl: string | undefined): string {
  const withoutBlocks = html.replace(/<!--[\s\S]*?-->/g, '').replace(LEGACY_DROPPED_BLOCKS, '');
  return withoutBlocks
    .split(LEGACY_TOKEN)
    .map((part, index) => (index % 2 === 1
      ? sanitizeLegacyTag(part, publicUrl)
      : part.replace(/</g, '&lt;').replace(/>/g, '&gt;')))
    .join('');
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}

function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '- ')
      .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|pre|ul|ol|table)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Render submission content for email. Lexical JSON is serialized node by node; legacy
 * HTML is sanitized and kept as HTML; anything else is plain text (escaped, newlines as <br>).
 */
export function renderContentForEmail(content: unknown, options: RenderOptions = {}): RenderedEmailBody {
  const { publicUrl } = options;
  const lexical = parseLexical(content);
  if (lexical) {
    const html = renderNodeHtml(lexical.root, { publicUrl });
    const text = tidyText(nodeText(lexical.root, { publicUrl, listDepth: 0 }));
    return { html, text };
  }

  const raw = typeof content === 'string' ? content : '';
  if (!raw.trim()) return { html: '', text: '' };

  if (LOOKS_LIKE_HTML.test(raw)) {
    return { html: sanitizeLegacyHtml(raw, publicUrl), text: tidyText(htmlToText(raw)) };
  }

  const normalized = raw.replace(/\r\n?/g, '\n');
  return {
    html: `<p style="${BLOCK_MARGIN}">${escapeHtml(normalized).replace(/\n/g, '<br>')}</p>`,
    text: tidyText(normalized),
  };
}
