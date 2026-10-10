import { afterEach, expect, it, vi } from 'vitest';
import { GitHubObsidianClient } from '../mcp-worker/src/github/client.ts';
const config = { token: 'test', owner: 'owner', repo: 'repo', branch: 'notes' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const file = (content: string, sha = 'current') => ({ type: 'file', size: new TextEncoder().encode(content).length, sha, content: Buffer.from(content).toString('base64'), encoding: 'base64' });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function mockRepo(notes: Record<string, string>, options: { search?: string[]; treeTruncated?: boolean; commitDate?: string } = {}) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = decodeURIComponent(url.pathname);
    if (path === '/search/code') {
      if (options.search) return json({ items: options.search.map(path => ({ path: `main/${path}`, name: path.split('/').pop() })) });
      return json({}, 403);
    }
    if (path.includes('/branches/')) return json({ commit: { sha: 'tree' } });
    if (path.includes('/git/trees/')) return json({ truncated: options.treeTruncated ?? false, tree: Object.keys(notes).map(path => ({ type: 'blob', path: `main/${path}`, sha: 'current', size: notes[path]!.length })) });
    if (path.endsWith('/contents/main')) return json([]);
    if (path.endsWith('/commits')) return json([{ sha: 'commit', commit: { message: 'updated', committer: { date: options.commitDate ?? '2026-10-10T00:00:00Z' }, author: { name: 'Author', date: '2026-10-01T00:00:00Z' } } }]);
    const note = path.split('/contents/main/')[1];
    if (note !== undefined && Object.hasOwn(notes, note)) {
      if (init?.method === 'PUT') return json({ content: { sha: 'updated' }, commit: { sha: 'new-commit' } });
      return json(file(notes[note]!));
    }
    return json({}, 404);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

it('enriches GitHub code search with actual configured-branch excerpts and line numbers', async () => {
  const fetch = mockRepo({ '会議.md': '序文\n決定事項です' }, { search: ['会議.md'] });
  const result = await new GitHubObsidianClient(config).searchNotes({ vault: 'main', query: '決定事項' });
  expect(result).toMatchObject({ ok: true, method: 'code_search', results: [{ sha: 'current', lineNumber: 2, snippet: '決定事項です' }] });
  expect(fetch.mock.calls.some(([url]) => String(url).includes('ref=notes'))).toBe(true);
});
it('falls back for empty code search, returns filename-only matches without a fake line number', async () => {
  mockRepo({ 'meeting.md': 'unrelated' }, { search: [] });
  const result = await new GitHubObsidianClient(config).searchNotes({ vault: 'main', query: 'meeting' });
  expect(result).toMatchObject({ ok: true, method: 'tree_scan', results: [{ match: 'filename', matches: [], lineNumber: undefined }] });
});
it('combines folder, all tags, and inclusive last commit date filters', async () => {
  const fetch = mockRepo({ 'Projects/yes.md': '---\ntags: [仕事, 会議]\n---\n決定', 'Projects/no.md': '#仕事\n決定', 'Other/no.md': '#仕事 #会議\n決定' });
  const client = new GitHubObsidianClient(config);
  const result = await client.searchNotes({ vault: 'main', query: '決定', folder: 'Projects', tags: ['#仕事', '会議'], updatedAfter: '2026-10-10T00:00:00Z', updatedBefore: '2026-10-10T00:00:00Z' });
  expect(result).toMatchObject({ ok: true, count: 1, results: [{ path: 'Projects/yes.md', updatedAt: '2026-10-10T00:00:00Z' }] });
  expect(fetch.mock.calls.every(([url]) => !String(url).includes('/search/code'))).toBe(true);
  expect(await client.searchNotes({ vault: 'main', query: '決定', updatedAfter: '2026-10-11T00:00:00Z' })).toMatchObject({ count: 0 });
});
it('rejects invalid dates and folder traversal before accessing note contents', async () => {
  const fetch = mockRepo({});
  const client = new GitHubObsidianClient(config);
  expect(await client.searchNotes({ query: 'x', updatedAfter: 'invalid' })).toMatchObject({ error: 'INVALID_INPUT' });
  expect(await client.searchNotes({ query: 'x', folder: '../secret' })).toMatchObject({ error: 'PATH_TRAVERSAL' });
  expect(fetch).not.toHaveBeenCalled();
});
it('reports bounded scans, continues without duplicates, and exposes truncated trees', async () => {
  const notes = Object.fromEntries(Array.from({ length: 81 }, (_, index) => [`${String(index).padStart(3, '0')}.md`, index === 80 ? 'needle' : 'other']));
  mockRepo(notes);
  const client = new GitHubObsidianClient(config);
  expect(await client.searchNotes({ vault: 'main', query: 'needle', scanOffset: 0 })).toMatchObject({ count: 0, scanned: 80, truncated: true, nextScanOffset: 80 });
  expect(await client.searchNotes({ vault: 'main', query: 'needle', scanOffset: 80 })).toMatchObject({ count: 1, scanned: 1, truncated: false, nextScanOffset: null });
  mockRepo({ 'a.md': 'needle' }, { treeTruncated: true });
  expect(await client.searchNotes({ vault: 'main', query: 'needle', scanOffset: 0 })).toMatchObject({ truncated: true, nextScanOffset: null });
});
it('batch reads keep order, partial errors, and proper GitHub commit metadata', async () => {
  mockRepo({ 'a.md': 'hello' });
  const client = new GitHubObsidianClient(config);
  expect(await client.readNotes({ notes: [{ vault: 'main', path: 'missing.md' }, { vault: 'main', path: 'a.md' }] })).toMatchObject({ ok: true, count: 2, results: [
    { path: 'missing.md', result: { ok: false, error: 'NOT_FOUND' } },
    { path: 'a.md', result: { ok: true, content: 'hello', lastCommit: { sha: 'commit', author: 'Author', message: 'updated' } } },
  ] });
  expect(await client.readNotes({ notes: [] })).toMatchObject({ error: 'INVALID_INPUT' });
});
it('edits only the requested section and writes with the observed SHA', async () => {
  const fetch = mockRepo({ 'a.md': '# Title\nintro\n## Decisions\nold\n## Next\nkeep' });
  const client = new GitHubObsidianClient(config);
  expect(await client.updateNoteSection({ vault: 'main', path: 'a.md', heading: 'Decisions', content: 'new', expectedSha: 'current' })).toMatchObject({ ok: true, sha: 'updated' });
  const write = fetch.mock.calls.find(([, init]) => init?.method === 'PUT')!;
  const body = JSON.parse(String(write[1]!.body));
  expect(body.sha).toBe('current');
  expect(Buffer.from(body.content, 'base64').toString()).toBe('# Title\nintro\n## Decisions\nnew\n\n## Next\nkeep');
});
it('does not write stale, missing or ambiguous headings, including a race during the second read', async () => {
  const fetch = mockRepo({ 'a.md': '## A\none\n## A\ntwo' });
  const client = new GitHubObsidianClient(config);
  expect(await client.updateNoteSection({ vault: 'main', path: 'a.md', heading: 'A', content: 'new', expectedSha: 'stale' })).toMatchObject({ error: 'CONFLICT' });
  expect(await client.updateNoteSection({ vault: 'main', path: 'a.md', heading: 'A', content: 'new', expectedSha: 'current' })).toMatchObject({ error: 'AMBIGUOUS_HEADING' });
  expect(await client.updateNoteSection({ vault: 'main', path: 'a.md', heading: 'B', content: 'new', expectedSha: 'current' })).toMatchObject({ error: 'HEADING_NOT_FOUND' });
  const implementation = fetch.getMockImplementation()!;
  let reads = 0;
  fetch.mockImplementation(async (url, init) => {
    if (String(url).includes('/contents/main/a.md') && !init?.method && ++reads === 2) return json(file('## A\nconcurrent edit', 'changed'));
    return implementation(url, init);
  });
  expect(await client.updateNoteSection({ vault: 'main', path: 'a.md', heading: 'A', occurrence: 1, content: 'new', expectedSha: 'current' })).toMatchObject({ error: 'CONFLICT', currentSha: 'changed' });
  expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
});
it('returns backlinks with source excerpts and excludes self-links and unrelated notes', async () => {
  mockRepo({ 'Projects/target.md': '[[target]]', 'Inbox/source.md': 'intro\n[[Projects/target#heading|alias]]', 'other.md': 'plain target mention' });
  expect(await new GitHubObsidianClient(config).getBacklinks({ vault: 'main', path: 'Projects/target.md' })).toMatchObject({ ok: true, count: 1, results: [{ path: 'Inbox/source.md', matches: [{ lineNumber: 2 }] }] });
});

it('rejects incomplete Contents API bodies without attempting section writes', async () => {
  const fetch = mockRepo({ 'a.md': '# A\nold' });
  const implementation = fetch.getMockImplementation()!;
  fetch.mockImplementation(async (url, init) => {
    if (String(url).includes('/contents/main/a.md') && !init?.method) return json({ type: 'file', size: 100, sha: 'current', encoding: 'base64' });
    return implementation(url, init);
  });
  expect(await new GitHubObsidianClient(config).updateNoteSection({ vault: 'main', path: 'a.md', heading: 'A', content: 'new', expectedSha: 'current' })).toMatchObject({ ok: false, error: 'GITHUB_ERROR' });
  expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
});
