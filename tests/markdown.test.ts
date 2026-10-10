import { expect, it } from 'vitest';
import { findMatches, extractTags, replaceSection, backlinkMatches } from '../shared/src/markdown.ts';

it('returns literal Japanese matches with one-based line numbers and bounded excerpts', () => {
  expect(findMatches('intro\n会議の決定事項\nother\n決定事項の続き', '決定事項')).toEqual([
    { lineNumber: 2, snippet: '会議の決定事項' }, { lineNumber: 4, snippet: '決定事項の続き' },
  ]);
  expect(findMatches('X'.repeat(1000), 'x')[0]!.snippet.length).toBeLessThan(300);
});
it('reads inline and common YAML tags, excluding code and tag prefixes', () => {
  expect(extractTags('---\ntags: [仕事, "idea"]\n---\n#仕事 #仕事/会議\n`#fake`\n```\n#bad\n```')).toEqual(['idea', '仕事', '仕事/会議']);
  expect(extractTags('---\ntags:\n  - foo\n  - "bar"\n---\n')).toEqual(['bar', 'foo']);
});
it('replaces a section and its children while preserving adjacent sections and fenced headings', () => {
  const content = '# Title\nintro\n## Decisions\nold\n```md\n# fake\n```\n### Child\nold child\n## Next\nkeep\n';
  expect(replaceSection(content, 'Decisions', 'new')).toEqual({ ok: true, content: '# Title\nintro\n## Decisions\nnew\n\n## Next\nkeep\n' });
});
it('requires occurrence for duplicate headings, supports Setext and CRLF', () => {
  expect(replaceSection('## A\nx\n## A\ny', 'A', 'z')).toMatchObject({ ok: false, error: 'AMBIGUOUS_HEADING' });
  expect(replaceSection('## A\nx\n## A\ny', 'A', 'z', 2)).toEqual({ ok: true, content: '## A\nx\n## A\nz\n' });
  expect(replaceSection('Heading\r\n=======\r\nold\r\nNext\r\n====\r\nkeep', 'Heading', 'new')).toEqual({ ok: true, content: 'Heading\r\n=======\r\nnew\r\n\r\nNext\r\n====\r\nkeep' });
  expect(replaceSection('# A\nx', 'missing', 'z')).toMatchObject({ ok: false, error: 'HEADING_NOT_FOUND' });
});
it('preserves heading boundaries with inline code, closing hashes, and frontmatter', () => {
  expect(replaceSection('# A\nold\n# `B`\nkeep', 'A', 'new')).toEqual({ ok: true, content: '# A\nnew\n\n# `B`\nkeep' });
  expect(replaceSection('# A#\nold', 'A#', 'new')).toMatchObject({ ok: true });
  expect(replaceSection('---\ntitle: A\n---\n# A\nold', 'title: A', 'new')).toMatchObject({ ok: false });
});
it('finds wikilinks, embeds, aliases, anchors and relative URL-encoded Markdown links', () => {
  const text = '[[Projects/会議#決定|alias]]\n![[会議]]\n[link](../Projects/%E4%BC%9A%E8%AD%B0.md#heading)\n[[other]]\n`[[会議]]`\n```\n[[会議]]\n```';
  expect(backlinkMatches(text, 'Inbox/source.md', 'Projects/会議.md', ['Projects/会議.md', 'Inbox/source.md']).map(match => match.lineNumber)).toEqual([1, 2, 3]);
});
it('does not match ambiguous basenames, wrong folders, remote links or vault escapes', () => {
  expect(backlinkMatches('[[note]]\n[[B/note]]\n[x](https://example.com/A/note.md)\n[x](../../A/note.md)', 'source.md', 'A/note.md', ['A/note.md', 'B/note.md'])).toEqual([]);
});
