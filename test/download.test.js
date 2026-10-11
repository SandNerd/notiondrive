import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { downloadPages } from '../src/download.js';

function createNoopHooks() {
  return {
    onStatus: () => {},
    onLog: () => {},
    onError: () => {},
  };
}

test('downloadPages exports one RFC4180 CSV per database and resolves relations', async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), 'notiondrive-csv-test-'));

  try {
    const notion = {
      throttledClient: {},
      queryDatabase: async () => [
        {
          id: 'row-1',
          properties: {
            name_prop: { type: 'title', title: [{ plain_text: 'Alpha, Row' }] },
            status_prop: { type: 'status', status: { name: 'Open' } },
            rel_prop: { type: 'relation', relation: [{ id: 'rel-1' }] },
          },
        },
      ],
      getDatabase: async () => ({
        properties: {
          name_prop: { type: 'title', name: 'Name' },
          status_prop: { type: 'status', name: 'Status' },
          rel_prop: { type: 'relation', name: 'Related' },
        },
      }),
      getPage: async (id) => ({
        id,
        properties: {
          Name: { type: 'title', title: [{ plain_text: 'Related Title' }] },
        },
      }),
    };

    const stats = await downloadPages(
      [{ id: 'db-1', name: 'Test DB', type: 'database' }],
      outDir,
      notion,
      createNoopHooks(),
      { format: 'csv' }
    );

    const csvPath = path.join(outDir, 'test-db.csv');
    const csv = await readFile(csvPath, 'utf8');

    assert.equal(stats.totalPages, 0);
    assert.ok(csv.includes('Name,Status,Related\r\n'));
    assert.ok(csv.includes('"Alpha, Row",Open,Related Title\r\n'));
    assert.ok(csv.endsWith('\r\n'));
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('downloadPages keeps markdown database behavior by default', async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), 'notiondrive-md-test-'));

  try {
    const notion = {
      throttledClient: {},
      queryDatabase: async () => [
        {
          id: 'row-1',
          properties: {
            Name: { type: 'title', title: [{ plain_text: 'Row One' }] },
          },
        },
      ],
      getBlockChildrenDeep: async () => ({ blocks: [], warnings: [] }),
    };

    const stats = await downloadPages(
      [{ id: 'db-1', name: 'Test DB', type: 'database' }],
      outDir,
      notion,
      createNoopHooks()
    );

    const dbFolder = path.join(outDir, 'test-db');
    const rowFile = path.join(dbFolder, 'Row-One.md');
    await access(rowFile);

    assert.equal(stats.totalPages, 1);
    // Ensure writtenFiles is populated with the row file
    assert.ok(Array.isArray(stats.writtenFiles));
    const hasRow = stats.writtenFiles.some((p) => p.endsWith('Row-One.md'));
    assert.ok(hasRow, 'expected writtenFiles to include Row-One.md');
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('downloadPages exports a flat markdown database as a single table file', async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), 'notiondrive-flat-md-test-'));

  try {
    const notion = {
      throttledClient: {},
      queryDatabase: async () => [
        {
          id: 'row-1',
          properties: {
            Name: { type: 'title', title: [{ plain_text: 'Row One' }] },
            Person: { type: 'people', people: [{ name: 'Sahal' }] },
            'Created time': { type: 'created_time', created_time: '2026-05-28T12:34:56.000Z' },
          },
        },
      ],
      getDatabase: async () => ({
        properties: {
          Name: { type: 'title', name: 'Name' },
          Person: { type: 'people', name: 'Person' },
          'Created time': { type: 'created_time', name: 'Created time' },
        },
      }),
    };

    const stats = await downloadPages(
      [{ id: 'db-1', name: 'Test DB', type: 'database', customFilename: 'database-export' }],
      outDir,
      notion,
      createNoopHooks(),
      { format: 'flattened' }
    );

    const outputPath = path.join(outDir, 'database-export');
    const output = await readFile(outputPath, 'utf8');

    assert.equal(stats.totalPages, 1);
    assert.ok(output.includes('| Name | Person | Created time |'));
    assert.ok(output.includes('| Row One | Sahal | 2026-05-28T12:34:56.000Z |'));
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('downloadPages supports string-based frontmatter from properties', async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), 'notiondrive-fm-str-'));
  await mkdir(outDir, { recursive: true });
  try {
    const notion = {
      throttledClient: {},
      getPage: async (id) => ({
        id,
        properties: {
          title: { type: 'title', title: [{ plain_text: 'My Page' }] },
          metadata: { type: 'rich_text', rich_text: [{ plain_text: 'key: value\ntags: test' }] },
          empty_prop: { type: 'rich_text', rich_text: [] },
        },
      }),
      getBlockChildrenDeep: async () => ({ blocks: [], warnings: [] }),
    };

    // 1. Test valid string property
    const statsStr = await downloadPages(
      [{ id: 'page-1', name: 'My Page', type: 'page' }],
      outDir,
      notion,
      createNoopHooks(),
      { format: 'markdown-tree', frontmatter: 'metadata' }
    );
    const contentStr = await readFile(path.join(outDir, 'My-Page.md'), 'utf8');
    assert.ok(contentStr.startsWith('---\nkey: value\ntags: test\n---\n\n'), 'Frontmatter should contain metadata property content');

    // 2. Test empty/missing property should omit frontmatter block
    const statsEmpty = await downloadPages(
      [{ id: 'page-2', name: 'Empty FM', type: 'page' }],
      outDir,
      notion,
      createNoopHooks(),
      { format: 'markdown-tree', frontmatter: 'empty_prop' }
    );
    const contentEmpty = await readFile(path.join(outDir, 'Empty-FM.md'), 'utf8');
    assert.ok(!contentEmpty.includes('---'), 'Should not contain frontmatter block for empty property');

    // 3. Test boolean true still works
    const statsBool = await downloadPages(
      [{ id: 'page-3', name: 'Bool FM', type: 'page' }],
      outDir,
      notion,
      createNoopHooks(),
      { format: 'markdown-tree', frontmatter: true }
    );
    const contentBool = await readFile(path.join(outDir, 'Bool-FM.md'), 'utf8');
    assert.ok(contentBool.includes('---'), 'Should contain frontmatter block for boolean true');
    assert.ok(contentBool.includes('metadata:'), 'Should contain standard YAML properties');

  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('downloadDatabase supported string-based frontmatter for rows', async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), 'notiondrive-db-fm-str-'));
  await mkdir(outDir, { recursive: true });
  try {
    const notion = {
      throttledClient: {},
      queryDatabase: async () => [
        {
          id: 'row-1',
          properties: {
            Name: { type: 'title', title: [{ plain_text: 'Row 1' }] },
            Header: { type: 'rich_text', rich_text: [{ plain_text: 'layout: post' }] },
          },
        },
      ],
      getBlockChildrenDeep: async () => ({ blocks: [], warnings: [] }),
    };

    await downloadPages(
      [{ id: 'db-1', name: 'My DB', type: 'database' }],
      outDir,
      notion,
      createNoopHooks(),
      { format: 'markdown-tree', frontmatter: 'Header' }
    );
    
    const rowContent = await readFile(path.join(outDir, 'My-DB', 'Row-1.md'), 'utf8');
    assert.ok(rowContent.startsWith('---\nlayout: post\n---\n\n'), 'Row should have frontmatter from "Header" property');
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
