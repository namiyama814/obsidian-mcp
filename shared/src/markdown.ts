export type TextMatch = { lineNumber: number; snippet: string };

/** Literal, case-insensitive matches; line numbers are one-based. */
export function findMatches(content: string, query: string): TextMatch[] {
  if (!query) return [];
  const lines = content.split(/\r?\n/);
  const matches: TextMatch[] = [];
  const lower = query.toLowerCase();
  for (let i = 0; i < lines.length && matches.length < 5; i++) {
    const line = lines[i]!;
    const index = line.toLowerCase().indexOf(lower);
    if (index >= 0) matches.push({ lineNumber: i + 1, snippet: line.slice(Math.max(0, index - 80), index + Math.min(query.length, 200) + 80) });
  }
  return matches;
}

/** Remove code while preserving line numbers and offsets. */
function withoutCode(content: string, inline = true): string {
  let fence: { char: string; length: number } | undefined;
  return content.split('\n').map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1]![0] === fence.char && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined;
      return line.replace(/[^\r]/g, ' ');
    }
    if (marker) { fence = { char: marker[1]![0]!, length: marker[1]!.length }; return line.replace(/[^\r]/g, ' '); }
    if (!inline) return line;
    return line.replace(/(`+)([^`]|(?!\1)`)*?\1/g, match => ' '.repeat(match.length));
  }).join('\n');
}

export function extractTags(content: string): string[] {
  const tags = new Set<string>();
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (frontmatter) {
    const lines = frontmatter[1]!.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const match = /^tags:\s*(.*)$/.exec(lines[i]!);
      if (!match) continue;
      const value = match[1]!;
      if (value.trim()) {
        for (const tag of value.replace(/^\[|\]$/g, '').split(',')) addTag(tag);
      } else {
        while (i + 1 < lines.length && /^\s+-\s+/.test(lines[i + 1]!)) addTag(lines[++i]!.replace(/^\s+-\s+/, ''));
      }
    }
  }
  const body = withoutCode(content.slice(frontmatter?.[0].length ?? 0));
  for (const match of body.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)) addTag(match[1]!);
  function addTag(tag: string) {
    const normalized = tag.trim().replace(/^['"]|['"]$/g, '').replace(/^#/, '').toLowerCase();
    if (normalized && !/\s/.test(normalized)) tags.add(normalized);
  }
  return [...tags].sort();
}

export function replaceSection(content: string, heading: string, body: string, occurrence?: number):
  { ok: true; content: string } | { ok: false; error: string; message: string } {
  if (!heading.trim() || (occurrence !== undefined && (!Number.isInteger(occurrence) || occurrence < 1))) {
    return { ok: false, error: 'INVALID_INPUT', message: 'Provide a heading title and a positive one-based occurrence.' };
  }
  const original = content.split(/\r?\n/);
  const visible = withoutCode(content, false).split(/\r?\n/);
  const headings: Array<{ line: number; end: number; level: number; title: string }> = [];
  // Frontmatter may contain a title followed by ---, which is not a Setext heading.
  const fm = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(content);
  const start = fm ? fm[0].split('\n').length - 1 : 0;
  for (let i = start; i < visible.length; i++) {
    const atx = /^ {0,3}(#{1,6})(?:\s+(.*)|\s*)$/.exec(visible[i]!);
    if (atx) { headings.push({ line: i, end: i + 1, level: atx[1]!.length, title: (atx[2] ?? '').replace(/\s+#+\s*$/, '').trim() }); continue; }
    const underline = /^ {0,3}(=+|-+)\s*$/.exec(visible[i + 1] ?? '');
    if (visible[i]!.trim() && underline) {
      headings.push({ line: i, end: i + 2, level: underline[1]![0] === '=' ? 1 : 2, title: visible[i]!.trim() }); i++;
    }
  }
  const candidates = headings.filter(item => item.title === heading.trim());
  if (!candidates.length || (occurrence !== undefined && occurrence > candidates.length)) return { ok: false, error: 'HEADING_NOT_FOUND', message: 'Heading occurrence not found.' };
  if (candidates.length > 1 && occurrence === undefined) return { ok: false, error: 'AMBIGUOUS_HEADING', message: 'Multiple headings have this title. Specify occurrence (one-based).' };
  const target = candidates[(occurrence ?? 1) - 1]!;
  const end = headings.find(item => item.line > target.line && item.level <= target.level)?.line ?? original.length;
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const prefix = original.slice(0, target.end).join(newline) + newline;
  const suffix = original.slice(end).join(newline);
  const replacement = body.replace(/\r\n/g, '\n').replace(/\n+$/, '').replace(/\n/g, newline);
  return { ok: true, content: prefix + (replacement ? replacement + newline : '') + (suffix ? newline + suffix : '') };
}

/** Resolve links within a vault; ambiguous basename links are omitted. */
export function backlinkMatches(content: string, source: string, target: string, paths: string[]): TextMatch[] {
  const visible = withoutCode(content);
  const matches: TextMatch[] = [];
  const lines = content.split(/\r?\n/);
  const clean = (value: string) => value.replace(/\.md$/i, '');
  const normalizedTarget = clean(target);
  for (const match of visible.matchAll(/!?\[\[([^\]\n]+)\]\]|!?\[[^\]\n]*\]\((<[^>\n]+>|[^\s)]+)(?:\s+"[^"\n]*")?\)/g)) {
    const wiki = match[1] !== undefined;
    let raw = wiki ? match[1]!.split('|')[0]! : match[2]!.replace(/^<|>$/g, '');
    raw = raw.split('#')[0]!;
    try { raw = decodeURIComponent(raw); } catch { continue; }
    if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
    let resolved: string | undefined;
    if (wiki) {
      const name = clean(raw.replace(/^\//, ''));
      if (paths.some(path => clean(path) === name)) resolved = name;
      else {
        const candidates = paths.filter(path => clean(path) === name || clean(path).endsWith('/' + name));
        if (candidates.length === 1) resolved = clean(candidates[0]!);
      }
    } else {
      const parts = raw.startsWith('/') ? [] : source.split('/').slice(0, -1);
      for (const part of raw.split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') { if (!parts.length) { parts.push('__outside_vault__'); break; } parts.pop(); }
        else parts.push(part);
      }
      resolved = clean(parts.join('/'));
    }
    if (resolved !== normalizedTarget) continue;
    const lineNumber = visible.slice(0, match.index).split('\n').length;
    if (!matches.some(item => item.lineNumber === lineNumber)) matches.push({ lineNumber, snippet: lines[lineNumber - 1]!.slice(0, 240) });
    if (matches.length >= 20) break;
  }
  return matches;
}
