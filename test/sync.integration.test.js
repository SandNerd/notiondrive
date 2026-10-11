import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
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

test('executeSyncMode returns completedTargets when skip matches ledger', async () => {
  const originalCwd = process.cwd();
  const dir = await mkdtemp(path.join(tmpdir(), 'notiondrive-sync-test-'));
  try {
    process.chdir(dir);

    const pageId = '1234567890abcdef1234567890abcdef';
    const manifest = { targets: [{ source: `https://notion.so/${pageId}`, outDir: '.', filename: 'My Page' }] };

    const rel = 'my-page.md';
    const mdPath = path.join(dir, rel);
    await writeFile(mdPath, '# cached\n', 'utf8');

    const crypto = await import('node:crypto');
    const { readFile } = await import('node:fs/promises');
    const buf = await readFile(mdPath);
    const hash = crypto.createHash('sha256').update(buf).digest('hex');

    const ledger = {
      byNotionId: { [pageId]: { notion_id: pageId, outputs: { [rel]: { last_synced_remote_mtime: '2025-01-01T00:00:00.000Z', last_synced_local_hash: hash } } } },
      byPath: { [rel]: pageId },
    };
    await writeFile('.notiondrive-state.json', JSON.stringify(ledger, null, 2), 'utf8');

    class MockNotion {
      async validateToken() {}
      async getPage(id) {
        return { id, last_edited_time: '2025-01-01T00:00:00.000Z' };
      }
    }

    let downloadCalled = false;
    const mockDownload = async () => {
      downloadCalled = true;
      return { writtenFiles: [] };
    };

    const result = await executeSyncMode(manifest, 'fake-token', { debug: false }, { notionClass: MockNotion, downloadPages: mockDownload, prompts: createNoopPrompts(), loadStateLedger: () => ledger });

    assert.equal(downloadCalled, false, 'downloadPages should not have been called when ledger is up-to-date');
    assert.ok(result.completedTargets.some((t) => t.skipped), 'should have a skipped target');
  } finally {
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('upload targets with markdown tables are aborted unless override sync is active', async () => {
  const originalCwd = process.cwd();
  const dir = await mkdtemp(path.join(tmpdir(), 'notiondrive-safety-test-'));
  try {
    process.chdir(dir);

    const pageId = 'deadbeefdeadbeefdeadbeefdeadbeef';
    const rel = 'table.md';
    const mdPath = path.join(dir, rel);
    const tableContent = `| a | b |\n| --- | --- |\n| 1 | 2 |\n`;
    await writeFile(mdPath, tableContent, 'utf8');

    const crypto = await import('node:crypto');
    const buf = await import('node:fs/promises').then((m) => m.readFile(mdPath));
    const hash = crypto.createHash('sha256').update(buf).digest('hex');

    // Ledger records an older hash so push will be attempted
    const ledger = {
      byNotionId: { [pageId]: { notion_id: pageId, outputs: { [rel]: { last_synced_remote_mtime: '2026-01-01T00:00:00.000Z', last_synced_local_hash: 'older-hash' } } } },
      byPath: { [rel]: pageId },
    };

    for (const mode of ['two-way', 'push-only']) {
      const manifest = { targets: [{ source: `https://notion.so/${pageId}`, outDir: '.', filename: rel, sync: mode }] };

      let clearCalled = false;
      let appendCalled = false;
      class MockNotion {
        async validateToken() {}
        async getPage(id) { return { id, last_edited_time: '2026-01-01T00:00:00.000Z' }; }
        async clearPageContent() { clearCalled = true; return 0; }
        async appendPageContent() { appendCalled = true; return 1; }
        async getBlockChildren(_id) { return [{ type: 'child_database' }]; }
      }

      const result = await executeSyncMode(manifest, 'fake-token', { debug: false }, { notionClass: MockNotion, prompts: createNoopPrompts(), loadStateLedger: () => ledger, saveStateLedger: async () => {} });

      assert.ok(result.completedTargets.some((t) => t.skipped && t.reason === 'safety-bypass'), `mode=${mode} should have safety-bypass skipped target`);
      assert.equal(clearCalled, false, 'clear should not be called when aborted');
      assert.equal(appendCalled, false, 'append should not be called when aborted');
    }
  } finally {
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('upload targets with markdown tables are pushed when override sync is active', async () => {
  const originalCwd = process.cwd();
  const dir = await mkdtemp(path.join(tmpdir(), 'notiondrive-safety-override-test-'));
  try {
    process.chdir(dir);

    const pageId = 'feedfacefeedfacefeedfacefeedface';
    const rel = 'table.md';
    const mdPath = path.join(dir, rel);
    const tableContent = `| a | b |\n| --- | --- |\n| 1 | 2 |\n`;
    await writeFile(mdPath, tableContent, 'utf8');

    const ledger = {
      byNotionId: { [pageId]: { notion_id: pageId, outputs: { [rel]: { last_synced_remote_mtime: '2026-01-01T00:00:00.000Z', last_synced_local_hash: 'older-hash' } } } },
      byPath: { [rel]: pageId },
    };

    for (const mode of ['two-way', 'push-only']) {
      const manifest = { targets: [{ source: `https://notion.so/${pageId}`, outDir: '.', filename: rel, sync: mode }] };

      let clearCalled = false;
      let appendCalled = false;

      // Inject --force flag for this run so preflight allows the push
      const originalArgv = process.argv.slice();
      process.argv = process.argv.slice(0, 2).concat(['--force']);

      class MockNotion {
        async validateToken() {}
        async getPage(id) { return { id, last_edited_time: '2026-01-01T00:00:00.000Z' }; }
        async clearPageContent() { clearCalled = true; return 0; }
        async appendPageContent() { appendCalled = true; return 1; }
        async getBlockChildren(_id) { return [{ type: 'child_database' }]; }
      }

      const result = await executeSyncMode(manifest, 'fake-token', { debug: false }, { notionClass: MockNotion, prompts: createNoopPrompts(), loadStateLedger: () => ledger, saveStateLedger: async () => {} });
      process.argv = originalArgv;

      assert.ok(result.completedTargets.some((t) => t.pushed === true), `mode=${mode} should have pushed target`);
      assert.equal(clearCalled, true, 'clear should be called when override active');
      assert.equal(appendCalled, true, 'append should be called when override active');
    }
  } finally {
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('upload-only targets skip when local hash matches ledger', async () => {
  const originalCwd = process.cwd();
  const dir = await mkdtemp(path.join(tmpdir(), 'notiondrive-sync-test-'));
  try {
    process.chdir(dir);

    const pageId = 'abcdefabcdefabcdefabcdefabcdefab';
    const manifest = { targets: [{ source: `https://notion.so/${pageId}`, outDir: '.', filename: 'Upload Only', sync: 'push-only' }] };

    const rel = 'upload-only.md';
    const mdPath = path.join(dir, rel);
    await writeFile(mdPath, '# cached\n', 'utf8');

    const crypto = await import('node:crypto');
    const { readFile } = await import('node:fs/promises');
    const buf = await readFile(mdPath);
    const hash = crypto.createHash('sha256').update(buf).digest('hex');

    const ledger = {
      byNotionId: { [pageId]: { notion_id: pageId, outputs: { [rel]: { last_synced_remote_mtime: 'ignored', last_synced_local_hash: hash } } } },
      byPath: { [rel]: pageId },
    };

    let clearCalled = false;
    let appendCalled = false;

    class MockNotion {
      async validateToken() {}
      async getPage(id) {
        return { id, last_edited_time: '2025-01-01T00:00:00.000Z' };
      }
      async getBlockChildren() { return []; }
      async clearPageContent() {
        clearCalled = true;
        return 0;
      }
      async appendPageContent() {
        appendCalled = true;
        return 0;
      }
    }

    const result = await executeSyncMode(manifest, 'fake-token', { debug: false }, { notionClass: MockNotion, prompts: createNoopPrompts(), loadStateLedger: () => ledger, saveStateLedger: async () => {} });

    assert.equal(clearCalled, false, 'clearPageContent should not run when hashes match');
    assert.equal(appendCalled, false, 'appendPageContent should not run when hashes match');
    assert.ok(result.completedTargets.some((t) => t.skipped), 'should have a skipped target');
  } finally {
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('upload-only targets overwrite Notion when local hash changes', async () => {
  const originalCwd = process.cwd();
  const dir = await mkdtemp(path.join(tmpdir(), 'notiondrive-sync-test-'));
  try {
    process.chdir(dir);

    const pageId = 'fedcbafedcbafedcbafedcbafedcbafe';
    const manifest = { targets: [{ source: `https://notion.so/${pageId}`, outDir: '.', filename: 'Upload Only', sync: 'push-only' }] };

    const rel = 'upload-only.md';
    const mdPath = path.join(dir, rel);
    await writeFile(mdPath, '# updated\n', 'utf8');

    const ledger = {
      byNotionId: { [pageId]: { notion_id: pageId, outputs: { [rel]: { last_synced_remote_mtime: 'ignored', last_synced_local_hash: 'different-hash' } } } },
      byPath: { [rel]: pageId },
    };

    let clearCalled = false;
    let appendCalled = false;
    let downloadCalled = false;

    class MockNotion {
      constructor() {
        this.client = { pages: { update: async () => {} } };
      }
      async validateToken() {}
      async getPage(id) {
        return { id, last_edited_time: '2025-01-01T00:00:00.000Z' };
      }
      async getBlockChildren() { return []; }
      async clearPageContent() {
        clearCalled = true;
        return 0;
      }
      async appendPageContent() {
        appendCalled = true;
        return 1;
      }
    }

    const result = await executeSyncMode(manifest, 'fake-token', { debug: false }, {
      notionClass: MockNotion,
      prompts: createNoopPrompts(),
      loadStateLedger: () => ledger,
      saveStateLedger: async () => {},
      downloadPages: async () => {
        downloadCalled = true;
        return { writtenFiles: [] };
      },
    });

    assert.equal(clearCalled, true, 'clearPageContent should run when hashes differ');
    assert.equal(appendCalled, true, 'appendPageContent should run when hashes differ');
    assert.equal(downloadCalled, false, 'downloadPages should not be called for upload-only targets');
    assert.ok(result.completedTargets.some((t) => t.pushed === true), 'should have a pushed target');
  } finally {
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('push uploads strip frontmatter from body when frontmatter is defaulted off', async () => {
  const originalCwd = process.cwd();
  const dir = await mkdtemp(path.join(tmpdir(), 'notiondrive-frontmatter-strip-test-'));
  try {
    process.chdir(dir);

    const pageId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const rel = 'frontmatter.md';
    const mdPath = path.join(dir, rel);
    const source = `---\ntitle: Example\ncategory: docs\n---\n# Body\n\nContent\n`;
    await writeFile(mdPath, source, 'utf8');

    const ledger = {
      byNotionId: { [pageId]: { notion_id: pageId, outputs: { [rel]: { last_synced_remote_mtime: '2026-01-01T00:00:00.000Z', last_synced_local_hash: 'older-hash' } } } },
      byPath: { [rel]: pageId },
    };

    const appendCalls = [];
    class MockNotion {
      constructor() {
        this.client = { pages: { update: async () => { throw new Error('should not update properties'); } } };
      }
      async validateToken() {}
      async getPage(id) {
        return {
          id,
          last_edited_time: '2026-01-01T00:00:00.000Z',
          properties: { title: { type: 'title', title: [{ plain_text: 'Body' }] } },
        };
      }
      async getBlockChildren() { return []; }
      async clearPageContent() { return 0; }
      async appendPageContent(_pageId, blocks) { appendCalls.push(blocks); return blocks.length; }
    }

    const manifest = { targets: [{ source: `https://notion.so/${pageId}`, outDir: '.', filename: rel, sync: 'push-only' }] };
    const result = await executeSyncMode(manifest, 'fake-token', { debug: false }, { notionClass: MockNotion, prompts: createNoopPrompts(), loadStateLedger: () => ledger, saveStateLedger: async () => {} });

    assert.ok(result.completedTargets.some((t) => t.pushed === true), 'should push the updated file');
    assert.equal(appendCalls.length, 1, 'should append blocks once');
    assert.equal(appendCalls[0][0].type, 'paragraph');
    assert.equal(appendCalls[0][0].paragraph.rich_text[0].text.content, 'Content');
    assert.equal(JSON.stringify(appendCalls[0]).includes('title: Example'), false, 'frontmatter should not be present in uploaded blocks');
  } finally {
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('push uploads inject frontmatter into configured database property and strip it from body', async () => {
  const originalCwd = process.cwd();
  const dir = await mkdtemp(path.join(tmpdir(), 'notiondrive-frontmatter-inject-test-'));
  try {
    process.chdir(dir);

    const pageId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const rel = 'frontmatter.md';
    const mdPath = path.join(dir, rel);
    const source = `---\ntitle: Example\ncategory: docs\n---\n# Body\n\nRemaining content\n`;
    await writeFile(mdPath, source, 'utf8');

    const ledger = {
      byNotionId: { [pageId]: { notion_id: pageId, outputs: { [rel]: { last_synced_remote_mtime: '2026-01-01T00:00:00.000Z', last_synced_local_hash: 'older-hash' } } } },
      byPath: { [rel]: pageId },
    };

    const appendCalls = [];
    const updateCalls = [];
    class MockNotion {
      constructor() {
        this.client = { pages: { update: async (payload) => { updateCalls.push(payload); } } };
      }
      async validateToken() {}
      async getPage(id) { return { id, last_edited_time: '2026-01-01T00:00:00.000Z' }; }
      async getBlockChildren() { return []; }
      async clearPageContent() { return 0; }
      async appendPageContent(_pageId, blocks) { appendCalls.push(blocks); return blocks.length; }
    }

    const manifest = { targets: [{ source: `https://notion.so/${pageId}`, outDir: '.', filename: rel, sync: 'push-only', frontmatter: 'metadata' }] };
    const result = await executeSyncMode(manifest, 'fake-token', { debug: false }, { notionClass: MockNotion, prompts: createNoopPrompts(), loadStateLedger: () => ledger, saveStateLedger: async () => {} });

    assert.ok(result.completedTargets.some((t) => t.pushed === true), 'should push the updated file');
    assert.equal(updateCalls.length, 2, 'should inject metadata and update title');
    assert.equal(updateCalls[0].properties.metadata.rich_text[0].text.content.includes('title: Example'), true);
    assert.equal(updateCalls[1].properties.title.title[0].text.content, 'Body');
    assert.equal(appendCalls.length, 1, 'should append blocks once');
    assert.equal(JSON.stringify(appendCalls[0]).includes('title: Example'), false, 'frontmatter should not be present in uploaded blocks');
    assert.equal(appendCalls[0][0].type, 'paragraph');
  } finally {
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('push uploads injects only matching YAML key value into property', async () => {
  const originalCwd = process.cwd();
  const dir = await mkdtemp(path.join(tmpdir(), 'notiondrive-frontmatter-inject-key-test-'));
  try {
    process.chdir(dir);

    const pageId = 'cccccccccccccccccccccccccccccccc';
    const rel = 'issue-ops.md';
    const mdPath = path.join(dir, rel);
    const source = `---\ndescription: "Only this should land in Description"\nmode: tasking\n---\n\n# Title\n\nBody`;
    await writeFile(mdPath, source, 'utf8');

    const ledger = {
      byNotionId: { [pageId]: { notion_id: pageId, outputs: { [rel]: { last_synced_remote_mtime: '2026-01-01T00:00:00.000Z', last_synced_local_hash: 'older-hash' } } } },
      byPath: { [rel]: pageId },
    };

    const appendCalls = [];
    const updateCalls = [];
    class MockNotion {
      constructor() {
        this.client = { pages: { update: async (payload) => { updateCalls.push(payload); } } };
      }
      async validateToken() {}
      async getPage(id) {
        return { id, last_edited_time: '2026-01-01T00:00:00.000Z' };
      }
      async getBlockChildren() { return []; }
      async clearPageContent() { return 0; }
      async appendPageContent(_pageId, blocks) { appendCalls.push(blocks); return blocks.length; }
    }

    const manifest = { targets: [{ source: `https://notion.so/${pageId}`, outDir: '.', filename: rel, sync: 'push-only', frontmatter: 'Description' }] };
    await executeSyncMode(manifest, 'fake-token', { debug: false }, { notionClass: MockNotion, prompts: createNoopPrompts(), loadStateLedger: () => ledger, saveStateLedger: async () => {} });

    const descriptionUpdate = updateCalls.find((p) => p.properties && p.properties.Description);
    assert.ok(descriptionUpdate, 'Expected property update for Description');
    const rich = descriptionUpdate.properties.Description.rich_text || [];
    const injected = rich.map((c) => c?.text?.content || '').join('');
    assert.equal(injected.includes('description:'), false, 'Should not inject YAML key name');
    assert.equal(injected.includes('mode:'), false, 'Should not inject other YAML keys');
    assert.equal(injected.includes('Only this should land in Description'), true);
    assert.equal(JSON.stringify(appendCalls[0]).includes('description:'), false, 'frontmatter should not be present in uploaded blocks');
  } finally {
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

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
        outDir: outDir,
        filename: 'test-page.md',
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
        outDir: outDir,
        filename: 'test-page.md',
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

test('two-way sync local-wins conflicts overwrite Notion', async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), 'notiondrive-two-way-test-'));

  let downloadCalled = false;
  const notion = {
    validateToken: async () => {},
    getPage: (pageId) => Promise.resolve({ id: pageId, last_edited_time: '2026-05-28T11:00:00.000Z', properties: {} }),
    getBlockChildren: async () => [],
    client: { pages: { update: async () => {} } },
    clearPageContent: async () => 0,
    appendPageContent: async () => 1,
  };

  const pageId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const localFile = path.join(outDir, 'test-page.md');
  const localContent = '# Test Page\n';
  await writeFile(localFile, localContent, 'utf-8');

  const ledger = {
    byNotionId: {
      [pageId]: {
        notion_id: pageId,
        outputs: {
          [path.relative(process.cwd(), localFile)]: {
            last_synced_remote_mtime: '2026-05-28T10:00:00.000Z',
            last_synced_local_hash: 'older-hash',
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
        outDir: outDir,
        filename: 'test-page.md',
        sync: 'two-way',
        conflict: 'local-wins',
      },
    ],
  };

  const result = await executeSyncMode(
    manifest,
    'fake-token',
    { debug: false, noCache: false },
    {
      notion,
      downloadPages: async () => {
        downloadCalled = true;
        return { writtenFiles: [] };
      },
      loadStateLedger: () => ledger,
      saveStateLedger: async () => {},
      prompts: createNoopPrompts(),
    }
  );

  assert.ok(result.completedTargets.some((t) => t.pushed === true), 'should have a pushed target');
  assert.equal(downloadCalled, false, 'download should not be called for local-wins conflicts');
});

test('executeSyncMode returns completedTargets and failedTargets arrays', async () => {
  const notion = {
    validateToken: async () => {},
    getPage: () => Promise.resolve(null),
  };

  const manifest = {
    targets: [{ source: 'https://www.notion.so/11111111111111111111111111111111', outDir: '/tmp', filename: 'Test' }],
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

test('flat targets still skip when no nested dependencies are tracked', async () => {
  const originalCwd = process.cwd();
  const dir = await mkdtemp(path.join(tmpdir(), 'notiondrive-flat-cache-test-'));
  try {
    process.chdir(dir);

    const pageId = '22222222222222222222222222222222';
    const manifest = { targets: [{ source: `https://notion.so/${pageId}`, outDir: '.', filename: 'Flat Target', format: 'flattened' }] };

    const rel = 'flat-target.md';
    const mdPath = path.join(dir, rel);
    await writeFile(mdPath, '# cached\n', 'utf8');

    const crypto = await import('node:crypto');
    const { readFile } = await import('node:fs/promises');
    const buf = await readFile(mdPath);
    const hash = crypto.createHash('sha256').update(buf).digest('hex');

    const ledger = {
      byNotionId: { [pageId]: { notion_id: pageId, outputs: { [rel]: { last_synced_remote_mtime: '2026-01-01T00:00:00.000Z', last_synced_local_hash: hash } } } },
      byPath: { [rel]: pageId },
    };

    class MockNotion {
      async validateToken() {}
      async getPage(id) {
        return { id, last_edited_time: '2026-01-01T00:00:00.000Z' };
      }
    }

    let downloadCalled = false;
    const mockDownload = async () => {
      downloadCalled = true;
      return { writtenFiles: [] };
    };

    const result = await executeSyncMode(
      manifest,
      'fake-token',
      { debug: false },
      {
        notionClass: MockNotion,
        downloadPages: mockDownload,
        prompts: createNoopPrompts(),
        loadStateLedger: () => ledger,
        saveStateLedger: async () => {},
      }
    );

    assert.equal(downloadCalled, false, 'downloadPages should be skipped for flat targets when no dependency changes are recorded');
    assert.equal(result.failedTargets.length, 0, 'should have no failures');
  } finally {
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('targets with dependency changes bypass cache skip and re-download even when ledger matches', async () => {
  const originalCwd = process.cwd();
  const dir = await mkdtemp(path.join(tmpdir(), 'notiondrive-dependency-cache-test-'));
  try {
    process.chdir(dir);

    const pageId = '33333333333333333333333333333333';
    const manifest = { targets: [{ source: `https://notion.so/${pageId}`, outDir: '.' }] };

    const rel = 'synced-target.md';
    const mdPath = path.join(dir, rel);
    await writeFile(mdPath, '# cached\n', 'utf8');

    const crypto = await import('node:crypto');
    const { readFile } = await import('node:fs/promises');
    const buf = await readFile(mdPath);
    const hash = crypto.createHash('sha256').update(buf).digest('hex');

    const dependencies = [{ id: 'block-1', type: 'block', mtime: '2026-01-01T00:00:00.000Z' }];
    const ledger = {
      byNotionId: {
        [pageId]: {
          notion_id: pageId,
          outputs: {
            [rel]: {
              last_synced_remote_mtime: '2026-01-01T00:00:00.000Z',
              last_synced_local_hash: hash,
              dependencies,
            },
          },
        },
      },
      byPath: { [rel]: pageId },
    };

    let savedLedger = null;

    class MockNotion {
      async validateToken() {}
      async getPage(id) {
        return { id, last_edited_time: '2026-01-01T00:00:00.000Z' };
      }
      async getBlock(id) {
        return { id, last_edited_time: '2026-02-01T00:00:00.000Z' };
      }
    }

    let downloadCalled = false;
    const mockDownload = async () => {
      downloadCalled = true;
      return { writtenFiles: [mdPath], dependencies, totalPages: 1, totalAssets: 0, errors: [] };
    };

    const result = await executeSyncMode(
      manifest,
      'fake-token',
      { debug: false },
      {
        notionClass: MockNotion,
        downloadPages: mockDownload,
        prompts: createNoopPrompts(),
        loadStateLedger: () => ledger,
        saveStateLedger: async (state) => {
          savedLedger = state;
        },
      }
    );

    assert.equal(downloadCalled, true, 'downloadPages should run when a dependency timestamp changes');
    assert.equal(result.failedTargets.length, 0, 'should have no failures');
    assert.deepEqual(savedLedger.byNotionId[pageId].outputs[rel].dependencies, dependencies, 'dependency graph should be persisted in the ledger');
  } finally {
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true });
  }
});
test('pushing markdown with H1 at the top updates Notion title and strips H1 from body', async () => {
  const originalCwd = process.cwd();
  const dir = await mkdtemp(path.join(tmpdir(), 'notiondrive-h1-test-'));
  try {
    process.chdir(dir);

    const pageId = 'abc123abc123abc123abc123abc12345';
    const rel = 'h1-test.md';
    const mdPath = path.join(dir, rel);
    await writeFile(mdPath, '# New Title\n\nSome content', 'utf8');

    const manifest = { targets: [{ source: 'https://notion.so/' + pageId, outDir: '.', filename: rel, sync: 'push-only' }] };

    let updatedTitle = null;
    let bodyBlocks = [];
    class MockNotion {
      constructor() {
        this.client = {
          pages: {
            update: async ({ properties }) => {
              if (properties.title) updatedTitle = properties.title.title[0].text.content;
              if (properties.Name) updatedTitle = properties.Name.title[0].text.content;
            }
          }
        };
      }
      async validateToken() {}
      async getPage(id) { 
        return { 
          id, 
          last_edited_time: '2026-01-01T00:00:00.000Z',
          properties: { title: { type: 'title', title: [{ plain_text: 'Old Title' }] } }
        }; 
      }
      async getBlockChildren() { return []; }
      async clearPageContent() { return 0; }
      async appendPageContent(id, blocks) { 
        bodyBlocks = blocks; 
        return blocks.length; 
      }
    }

    await executeSyncMode(manifest, 'fake-token', { debug: false }, { notionClass: MockNotion, prompts: createNoopPrompts() });

    assert.equal(updatedTitle, 'New Title');
    assert.equal(bodyBlocks.length, 1);
    assert.equal(bodyBlocks[0].type, 'paragraph');
  } finally {
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('title: filename does not demote frontmatter-derived value into body', async () => {
  const originalCwd = process.cwd();
  const dir = await mkdtemp(path.join(tmpdir(), 'notiondrive-title-frontmatter-demote-test-'));
  try {
    process.chdir(dir);

    const pageId = 'dddddddddddddddddddddddddddddddd';
    const rel = 'optimize-github-actions.md';
    const yamlValue = 'audit and optimize GitHub Actions workflows to lower runner costs';
    const sourceMd = `---\ndescription: ${yamlValue}\n---\n\n# Body\n\nContent`;
    const mdPath = path.join(dir, rel);
    await writeFile(mdPath, sourceMd, 'utf8');

    const ledger = {
      byNotionId: {
        [pageId]: {
          notion_id: pageId,
          outputs: {
            [rel]: { last_synced_remote_mtime: '2026-01-01T00:00:00.000Z', last_synced_local_hash: 'older-hash' },
          },
        },
      },
      byPath: { [rel]: pageId },
    };

    const appendCalls = [];
    const updateCalls = [];

    let firstGetPage = true;
    class MockNotion {
      constructor() {
        this.client = { pages: { update: async (payload) => updateCalls.push(payload) } };
      }
      async validateToken() {}
      async getPage() {
        // Simulate an old cloud title that equals the frontmatter-derived value.
        // With title: "filename", code would normally demote the old title into
        // the page body. This test asserts we avoid that behavior.
        if (firstGetPage) {
          firstGetPage = false;
          return {
            id: pageId,
            last_edited_time: '2026-01-01T00:00:00.000Z',
            properties: {
              title: { type: 'title', title: [{ plain_text: yamlValue }] },
              Description: { type: 'rich_text', rich_text: [] },
            },
          };
        }

        return {
          id: pageId,
          last_edited_time: '2026-01-01T00:00:00.000Z',
          properties: {
            title: { type: 'title', title: [{ plain_text: rel }] },
            Description: { type: 'rich_text', rich_text: [] },
          },
        };
      }
      async getBlockChildren() {
        return [];
      }
      async clearPageContent() {}
      async appendPageContent(_pageId, blocks) {
        appendCalls.push(blocks);
        return blocks.length;
      }
    }

    const manifest = {
      targets: [
        {
          source: `https://notion.so/${pageId}`,
          outDir: '.',
          filename: rel,
          sync: 'push-only',
          frontmatter: 'Description',
          title: 'filename',
        },
      ],
    };

    const result = await executeSyncMode(manifest, 'fake-token', { debug: false, noCache: false }, {
      notionClass: MockNotion,
      prompts: createNoopPrompts(),
      loadStateLedger: () => ledger,
      saveStateLedger: async () => {},
    });

    assert.ok(result.completedTargets.some((t) => t.pushed === true), 'should push the updated file');
    assert.ok(appendCalls.length >= 1, 'should append blocks at least once');

    // appendPageContent can be invoked once during title alignment (demotion)
    // and once during the actual body upload. Validate the final append
    // payload only.
    const appendedStr = JSON.stringify(appendCalls[appendCalls.length - 1] || []);
    // Old cloud title value should not be inserted as a demotion H1.
    assert.equal(appendedStr.includes(yamlValue), false, 'should not demote frontmatter-derived value into body blocks');
    // Frontmatter itself is not in blocks either.
    assert.equal(appendedStr.includes('description:'), false, 'frontmatter should not be present in uploaded blocks');
  } finally {
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('H1 extraction works correctly with frontmatter: true', async () => {
  const originalCwd = process.cwd();
  const dir = await mkdtemp(path.join(tmpdir(), 'notiondrive-h1-fm-test-'));
  try {
    process.chdir(dir);

    const pageId = 'f00f00f00f00f00f00f00f00f00f00f0';
    const rel = 'h1-fm-test.md';
    const mdPath = path.join(dir, rel);
    await writeFile(mdPath, '---\ntags: test\n---\n\n# Metadata Title\n\nMore stuff', 'utf8');

    const manifest = { targets: [{ source: 'https://notion.so/' + pageId, outDir: '.', filename: rel, sync: 'push-only', frontmatter: true }] };

    let updatedTitle = null;
    let bodyBlocks = [];
    class MockNotion {
      constructor() {
        this.client = {
          pages: {
            update: async ({ properties }) => {
              if (properties.title) updatedTitle = properties.title.title[0].text.content;
            }
          }
        };
      }
      async validateToken() {}
      async getPage(id) { 
        return { 
          id, 
          last_edited_time: '2026-01-01T00:00:00.000Z',
          properties: { title: { type: 'title', title: [{ plain_text: 'Old Title' }] } }
        }; 
      }
      async getBlockChildren() { return []; }
      async clearPageContent() { return 0; }
      async appendPageContent(id, blocks) { 
        bodyBlocks = blocks; 
        return blocks.length; 
      }
    }

    await executeSyncMode(manifest, 'fake-token', { debug: false }, { notionClass: MockNotion, prompts: createNoopPrompts() });

    assert.equal(updatedTitle, 'Metadata Title');
    const h1Block = bodyBlocks.find(b => b.type === 'heading_1');
    assert.ok(!h1Block, 'H1 block should have been removed from body');
    // With the new rule, frontmatter should never appear in the pushed body.
    assert.equal(bodyBlocks.length, 1);
    assert.equal(bodyBlocks[0].type, 'paragraph');
  } finally {
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true });
  }
});
