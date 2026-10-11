import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { executeSyncMode } from '../src/sync.js';

function createNoopPrompts() {
  return {
    spinner: () => ({ start: () => {}, stop: () => {}, message: () => {} }),
    log: {
      info: () => {},
      warn: () => {},
      error: () => {},
      success: () => {},
    },
  };
}

test('two-way sync pushes to Notion and returns completedTargets', async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), 'notiondrive-two-way-test-'));

  const notion = {
    validateToken: async () => {},
    getPage: (pageId) => Promise.resolve({ id: pageId, last_edited_time: '2026-05-28T10:00:00.000Z', properties: {} }),
    getBlockChildren: async () => [],
    client: { pages: { update: async () => {} } },
    clearPageContent: async () => 0,
    appendPageContent: async (_pageId, blocks) => blocks.length,
  };

  const pageId = '1234567890abcdef1234567890abcdef';
  const localFile = path.join(outDir, 'test-page.md');
  const initialContent = '# Test Page\n\nInitial content.';
  await writeFile(localFile, initialContent, 'utf-8');

  const crypto = await import('node:crypto');
  const initialHash = crypto.createHash('sha256').update(initialContent).digest('hex');

  const ledger = {
    byNotionId: {
      [pageId]: {
        notion_id: pageId,
        outputs: {
          [path.relative(process.cwd(), localFile)]: {
            last_synced_remote_mtime: '2026-05-28T10:00:00.000Z',
            last_synced_local_hash: initialHash,
          },
        },
      },
    },
    byPath: {},
  };

  const modifiedContent = '# Test Page\n\nModified content.';
  await writeFile(localFile, modifiedContent, 'utf-8');

  const manifest = {
    targets: [
      {
        source: `https://www.notion.so/${pageId}`,
        path: path.join(outDir, 'test-page.md'),
        sync: 'two-way',
      },
    ],
  };

  const result = await executeSyncMode(
    manifest,
    'fake-token',
    { debug: false, noCache: false },
    {
      notion,
      loadStateLedger: () => ledger,
      saveStateLedger: async () => {},
      prompts: createNoopPrompts(),
    }
  );

  assert.ok(result.completedTargets.some((t) => t.pushed === true), 'should have a pushed target');
  assert.equal(result.failedTargets.length, 0, 'should have no failures');
});

test('two-way sync does not push when remote changed', async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), 'notiondrive-two-way-test-'));

  const notion = {
    validateToken: async () => {},
    getPage: (pageId) => Promise.resolve({ id: pageId, last_edited_time: '2026-05-28T11:00:00.000Z', properties: {} }),
    clearPageContent: async () => 0,
    appendPageContent: async () => 0,
  };

  let downloadCalled = false;
  const downloadFn = async () => {
    downloadCalled = true;
    return { writtenFiles: [path.join(outDir, 'downloaded.md')] };
  };

  const pageId = 'abcdef1234567890abcdef1234567890';
  const localFile = path.join(outDir, 'test-page.md');
  await writeFile(localFile, '# Test Page\n', 'utf-8');

  const crypto = await import('node:crypto');
  const contentHash = crypto.createHash('sha256').update('# Test Page\n').digest('hex');

  const ledger = {
    byNotionId: {
      [pageId]: {
        notion_id: pageId,
        outputs: {
          [path.relative(process.cwd(), localFile)]: {
            last_synced_remote_mtime: '2026-05-28T10:00:00.000Z',
            last_synced_local_hash: contentHash,
          },
        },
      },
    },
    byPath: {},
  };

  const manifest = {
    targets: [
      {
        source: `https://www.notion.so/${pageId}`,
        path: path.join(outDir, 'test-page.md'),
        sync: 'two-way',
      },
    ],
  };

  const result = await executeSyncMode(
    manifest,
    'fake-token',
    { debug: false, noCache: false },
    {
      notion,
      downloadPages: downloadFn,
      loadStateLedger: () => ledger,
      saveStateLedger: async () => {},
      prompts: createNoopPrompts(),
    }
  );

  assert.ok(downloadCalled, 'download should have been called when remote changed');
  assert.equal(result.failedTargets.length, 0, 'should have no failures');
});

test('executeSyncMode returns completedTargets and failedTargets arrays', async () => {
  const notion = {
    validateToken: async () => {},
    getPage: () => Promise.resolve(null),
  };

  const manifest = {
    targets: [{ source: 'https://www.notion.so/11111111111111111111111111111111', path: '/tmp/Test' }],
  };

  const result = await executeSyncMode(
    manifest,
    'fake-token',
    { debug: false, noCache: true },
    {
      notion,
      downloadPages: async () => ({ writtenFiles: [], totalPages: 0, totalAssets: 0, errors: [] }),
      prompts: createNoopPrompts(),
    }
  );

  assert.ok(Array.isArray(result.completedTargets), 'completedTargets should be an array');
  assert.ok(Array.isArray(result.failedTargets), 'failedTargets should be an array');
});