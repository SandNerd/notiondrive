import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, symlink, rm, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { discoverDocuments } from '../src/discovery.js';
import { NotionClient } from '../src/notion.js';

function page(id, name, directory) {
  return { id, properties: {
    Name: { type: 'title', title: [{ plain_text: name }] },
    'Repository Directory': { type: 'select', select: directory ? { id: 'dir-option', name: directory.replace(/\/$/, '') } : null },
  } };
}

async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notiondrive-discovery-'));
  await mkdir(path.join(root, '.agents', 'workflows'), { recursive: true });
  await mkdir(path.join(root, 'docs'), { recursive: true });
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('discovers a paginated 106-page inventory with 101 mappings and five exceptions', async () => {
  const rows = Array.from({ length: 101 }, (_, i) => page(`id-${i}`, `Part-${i}.blueprint.md`, '.agents/workflows/'));
  rows.push(...Array.from({ length: 5 }, (_, i) => ({ id: `missing-${i}`, properties: { Name: { type: 'title', title: [{ plain_text: 'orphan.md' }] } } })));
  const requestedCursors = [];
  const notion = { async queryDatabase() {
    const result = [];
    let cursor;
    do {
      requestedCursors.push(cursor ?? null);
      const offset = cursor ? Number(cursor) : 0;
      const chunk = rows.slice(offset, offset + 20);
      result.push(...chunk);
      cursor = offset + chunk.length < rows.length ? String(offset + chunk.length) : undefined;
    } while (cursor);
    return result;
  } };
  const result = await discoverDocuments({ notion, databaseId: 'db', root: process.cwd() });
  assert.equal(result.length, 106);
  assert.equal(result.filter((item) => item.status === 'mapped').length, 101);
  assert.equal(result.filter((item) => item.status === 'requires_review').length, 5);
  assert.equal(result[0].path, '.agents/workflows/Part-0.blueprint.md');
  assert.deepEqual(requestedCursors, [null, '20', '40', '60', '80', '100']);
  assert.deepEqual(Object.keys(result[0]).sort(), ['pageId', 'path', 'provenance', 'reason', 'source', 'status', 'title']);
});

test('rejects database paths with dot segments and supports data-source queries', async () => {
  await fixture(async (root) => {
    const invalid = await discoverDocuments({ notion: { queryDatabase: async () => [page('a', 'file.md', 'docs/../secret/')] }, databaseId: 'db', root });
    assert.equal(invalid[0].status, 'requires_review');
    assert.match(invalid[0].reason, /traversal/);
    let requested;
    const results = await discoverDocuments({ notion: { queryDataSource: async (id) => { requested = id; return [page('b', 'one.md', 'docs/')]; } }, dataSourceId: 'source-id', root });
    assert.equal(requested, 'source-id');
    assert.equal(results[0].path, 'docs/one.md');
  });
});

test('uses supported SDK API versions and endpoints for both source modes', async () => {
  const client = new NotionClient('fake-token');
  const requests = [];
  const response = { results: [], has_more: false, next_cursor: null };
  const fetch = async (url, options) => {
    requests.push({ url: new URL(url).pathname, version: options.headers['Notion-Version'] });
    return { ok: true, text: async () => JSON.stringify(response) };
  };
  client.client = new client.client.constructor({ auth: 'fake-token', fetch, logLevel: 'error' });
  client.dataSourceClient = new client.dataSourceClient.constructor({ auth: 'fake-token', fetch, logLevel: 'error', notionVersion: '2025-09-03' });
  client._minInterval = 0;
  assert.deepEqual(await client.queryDatabase('db-id'), []);
  assert.deepEqual(await client.queryDataSource('source-id'), []);
  assert.deepEqual(requests, [
    { url: '/v1/databases/db-id/query', version: '2022-06-28' },
    { url: '/v1/data_sources/source-id/query', version: '2025-09-03' },
  ]);
});

test('queries a Notion data source using the client interface', async () => {
  let requested;
  const results = await discoverDocuments({ notion: { queryDataSource: async (id) => { requested = id; return [page('data-source-page', 'one.md', 'docs/')]; } }, dataSourceId: 'source-id', root: process.cwd() });
  assert.equal(requested, 'source-id');
  assert.equal(results[0].path, 'docs/one.md');
});

test('normalizes incidental Markdown title formatting and preserves provenance', async () => {
  await fixture(async (root) => {
    const [result] = await discoverDocuments({ notion: { queryDatabase: async () => [page('a', '**Triage** _workflow_.md', '.agents/workflows/')] }, databaseId: 'db', root });
    assert.equal(result.path, '.agents/workflows/Triage workflow.md');
    assert.equal(result.source, 'derived');
    assert.equal(result.provenance.filename, '**Triage** _workflow_.md');
  });
});

test('classifies invalid paths, duplicate identities and duplicate destinations', async () => {
  await fixture(async (root) => {
    const results = await discoverDocuments({ notion: { queryDatabase: async () => [page('a', 'same.md', '../outside'), page('b', 'same.md', 'docs/'), page('c', 'same.md', 'docs/'), page('b', 'other.md', 'docs/')] }, databaseId: 'db', root });
    assert.equal(results[0].status, 'requires_review');
    assert.match(results[0].reason, /traversal/);
    assert.equal(results[1].path, null);
    assert.match(results[1].reason, /duplicate Notion page/);
    assert.equal(results[2].path, 'docs/same.md');
    assert.equal(results[3].path, null);
  });
});

test('rejects symlink escapes and validates override precedence/collisions', async () => {
  await fixture(async (root) => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'notiondrive-outside-'));
    try {
      await symlink(outside, path.join(root, 'escape'));
      await symlink(path.join(outside, 'missing-target'), path.join(root, 'dangling'));
      const results = await discoverDocuments({ notion: { queryDatabase: async () => [page('a', 'auto.md', 'docs/'), page('b', 'override.md', 'docs/'), page('c', 'file.md', 'escape/'), page('d', 'file.md', 'dangling/')] }, databaseId: 'db', root, overrides: [{ pageId: 'b', path: 'docs/auto.md' }] });
      assert.equal(results[0].status, 'requires_review');
      assert.equal(results[1].status, 'requires_review');
      assert.equal(results[1].source, 'explicit override');
      assert.match(results[2].reason, /symlink/);
      assert.equal(results[3].status, 'requires_review');
      assert.match(results[3].reason, /symlink/);
    } finally { await rm(outside, { recursive: true, force: true }); }
  });
});

test('rejects duplicate overrides and ambiguous property types', async () => {
  await fixture(async (root) => {
    const row = page('a', 'file.md', 'docs/');
    row.properties.Name = { type: 'number', number: 3 };
    const results = await discoverDocuments({ notion: { queryDatabase: async () => [row] }, databaseId: 'db', root, overrides: [{ pageId: 'a', path: 'docs/one.md' }, { pageId: 'a', path: 'docs/two.md' }] });
    assert.equal(results[0].path, null);
    assert.match(results[0].reason, /duplicate override/);
    assert.equal(results[1].status, 'requires_review');
    assert.match(results[1].reason, /duplicate override/);
  });
});

test('does not modify repository files on success or review exceptions', async () => {
  await fixture(async (root) => {
    const destination = path.join(root, 'docs', 'existing.md');
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, 'keep me');
    const before = await readFile(destination, 'utf8');
    const listingBefore = await readdir(root, { recursive: true });
    await discoverDocuments({ notion: { queryDatabase: async () => [page('a', 'new.md', 'docs/'), page('b', 'orphan.md', '')] }, databaseId: 'db', root });
    assert.equal(await readFile(destination, 'utf8'), before);
    assert.deepEqual(await readdir(root, { recursive: true }), listingBefore);
  });
});
