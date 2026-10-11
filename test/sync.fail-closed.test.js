import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { executeSyncMode } from '../src/sync.js';

function createNoopPrompts() {
  return {
    spinner: () => ({ start: () => {}, stop: () => {}, message: () => {} }),
    log: { info: () => {}, warn: () => {}, error: () => {}, success: () => {} },
  };
}

function createLedger(pageId, rel) {
  return {
    byNotionId: {
      [pageId]: {
        notion_id: pageId,
        outputs: {
          [rel]: {
            last_synced_remote_mtime: '2026-01-01T00:00:00.000Z',
            last_synced_local_hash: 'previous-local-hash',
          },
        },
      },
    },
    byPath: { [rel]: pageId },
  };
}

async function withTempDirectory(run) {
  const originalCwd = process.cwd();
  const dir = await mkdtemp(path.join(tmpdir(), 'notiondrive-fail-closed-'));
  try {
    process.chdir(dir);
    await run(dir);
  } finally {
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true });
  }
}

test('ordinary push refuses title, property, and content writes if block preflight fails', async () => {
  await withTempDirectory(async () => {
    const pageId = '11111111111111111111111111111111';
    const rel = 'page.md';
    await writeFile(rel, '---\nDescription: changed\n---\n# Updated\nBody\n', 'utf8');
    const ledger = createLedger(pageId, rel);
    const savedLedgers = [];
    let titleOrPropertyWrites = 0;
    let contentWrites = 0;

    class MockNotion {
      constructor() {
        this.client = { pages: { update: async () => { titleOrPropertyWrites++; } } };
      }
      async validateToken() {}
      async getPage(id) {
        return {
          id,
          last_edited_time: '2026-01-01T00:00:00.000Z',
          properties: { title: { type: 'title', title: [{ plain_text: 'Original' }] } },
        };
      }
      async getBlockChildren() { throw new Error('permission denied'); }
      async clearPageContent() { contentWrites++; }
      async appendPageContent() { contentWrites++; }
    }

    const result = await executeSyncMode({
      targets: [{ source: `https://notion.so/${pageId}`, outDir: '.', filename: rel, sync: 'push-only', title: 'filename', frontmatter: 'Description' }],
    }, 'offline-token', {}, {
      notionClass: MockNotion,
      prompts: createNoopPrompts(),
      loadStateLedger: () => ledger,
      saveStateLedger: async (state) => savedLedgers.push(structuredClone(state)),
    });

    assert.equal(result.failedTargets.length, 1);
    assert.equal(result.completedTargets.length, 0);
    assert.equal(titleOrPropertyWrites, 0);
    assert.equal(contentWrites, 0);
    assert.ok(savedLedgers.every((state) =>
      state.byNotionId[pageId].outputs[rel].last_synced_local_hash === 'previous-local-hash'
    ));
  });
});

test('ordinary push does not clear content or advance baseline after a title update fails', async () => {
  await withTempDirectory(async () => {
    const pageId = '22222222222222222222222222222222';
    const rel = 'page.md';
    await writeFile(rel, '# Updated\nBody\n', 'utf8');
    const ledger = createLedger(pageId, rel);
    const savedLedgers = [];
    let clearCalls = 0;
    let appendCalls = 0;

    class MockNotion {
      constructor() {
        this.client = { pages: { update: async () => { throw new Error('title write failed'); } } };
      }
      async validateToken() {}
      async getPage(id) {
        return {
          id,
          last_edited_time: '2026-01-01T00:00:00.000Z',
          properties: { title: { type: 'title', title: [{ plain_text: 'Original' }] } },
        };
      }
      async getBlockChildren() { return []; }
      async clearPageContent() { clearCalls++; }
      async appendPageContent() { appendCalls++; }
    }

    const result = await executeSyncMode({
      targets: [{ source: `https://notion.so/${pageId}`, outDir: '.', filename: rel, sync: 'push-only' }],
    }, 'offline-token', {}, {
      notionClass: MockNotion,
      prompts: createNoopPrompts(),
      loadStateLedger: () => ledger,
      saveStateLedger: async (state) => savedLedgers.push(structuredClone(state)),
    });

    assert.equal(result.failedTargets.length, 1);
    assert.equal(clearCalls, 0);
    assert.equal(appendCalls, 0);
    assert.ok(savedLedgers.every((state) =>
      state.byNotionId[pageId].outputs[rel].last_synced_local_hash === 'previous-local-hash'
    ));
  });
});

test('ordinary push does not advance baseline after a partial content append', async () => {
  await withTempDirectory(async () => {
    const pageId = '55555555555555555555555555555555';
    const rel = 'page.md';
    await writeFile(rel, 'Body changed\n', 'utf8');
    const ledger = createLedger(pageId, rel);
    const savedLedgers = [];
    let clearCalls = 0;
    let appendCalls = 0;

    class MockNotion {
      async validateToken() {}
      async getPage(id) { return { id, last_edited_time: '2026-01-01T00:00:00.000Z' }; }
      async getBlockChildren() { return []; }
      async clearPageContent() { clearCalls++; }
      async appendPageContent() {
        appendCalls++;
        throw new Error('append partially failed');
      }
    }

    const result = await executeSyncMode({
      targets: [{ source: `https://notion.so/${pageId}`, outDir: '.', filename: rel, sync: 'push-only' }],
    }, 'offline-token', {}, {
      notionClass: MockNotion,
      prompts: createNoopPrompts(),
      loadStateLedger: () => ledger,
      saveStateLedger: async (state) => savedLedgers.push(structuredClone(state)),
    });

    assert.equal(result.failedTargets.length, 1);
    assert.equal(clearCalls, 1);
    assert.equal(appendCalls, 1);
    assert.ok(savedLedgers.every((state) =>
      state.byNotionId[pageId].outputs[rel].last_synced_local_hash === 'previous-local-hash'
    ));
  });
});

test('failed ledger persistence cannot advance the in-memory or saved baseline', async () => {
  await withTempDirectory(async () => {
    const pageId = '66666666666666666666666666666666';
    const rel = 'page.md';
    await writeFile(rel, 'Body changed\n', 'utf8');
    const ledger = createLedger(pageId, rel);
    const attemptedSaves = [];

    class MockNotion {
      async validateToken() {}
      async getPage(id) { return { id, last_edited_time: '2026-02-01T00:00:00.000Z' }; }
      async getBlockChildren() { return []; }
      async clearPageContent() {}
      async appendPageContent() { return 1; }
    }

    const result = await executeSyncMode({
      targets: [{ source: `https://notion.so/${pageId}`, outDir: '.', filename: rel, sync: 'push-only' }],
    }, 'offline-token', {}, {
      notionClass: MockNotion,
      prompts: createNoopPrompts(),
      loadStateLedger: () => ledger,
      saveStateLedger: async (state) => {
        attemptedSaves.push(structuredClone(state));
        if (attemptedSaves.length === 1) throw new Error('ledger persistence failed');
      },
    });

    assert.equal(result.failedTargets.length, 1);
    assert.equal(attemptedSaves.length, 2, 'the final save should only retry the unchanged state');
    assert.notEqual(attemptedSaves[0].byNotionId[pageId].outputs[rel].last_synced_local_hash, 'previous-local-hash');
    assert.equal(attemptedSaves[1].byNotionId[pageId].outputs[rel].last_synced_local_hash, 'previous-local-hash');
  });
});

test('partial pull does not advance the ledger baseline from a written file', async () => {
  await withTempDirectory(async (dir) => {
    const pageId = '33333333333333333333333333333333';
    const rel = 'page.md';
    const filePath = path.join(dir, rel);
    await writeFile(filePath, '# Previous\n', 'utf8');
    const ledger = createLedger(pageId, rel);
    const savedLedgers = [];

    const result = await executeSyncMode({
      targets: [{ source: `https://notion.so/${pageId}`, outDir: '.', filename: rel, sync: 'pull-only' }],
    }, 'offline-token', {}, {
      notion: {
        getPage: async (id) => ({ id, last_edited_time: '2026-02-01T00:00:00.000Z' }),
      },
      prompts: createNoopPrompts(),
      loadStateLedger: () => ledger,
      saveStateLedger: async (state) => savedLedgers.push(structuredClone(state)),
      downloadPages: async () => {
        await writeFile(filePath, '# Partially downloaded\n', 'utf8');
        return {
          writtenFiles: [filePath],
          errors: [{ title: 'Page', error: 'a block could not be fetched' }],
        };
      },
    });

    assert.equal(await readFile(filePath, 'utf8'), '# Partially downloaded\n');
    assert.equal(result.failedTargets.length, 1);
    assert.equal(result.completedTargets.length, 0);
    assert.ok(savedLedgers.every((state) =>
      state.byNotionId[pageId].outputs[rel].last_synced_local_hash === 'previous-local-hash'
    ));
  });
});

test('pull-only title filename alignment never writes to Notion', async () => {
  await withTempDirectory(async () => {
    const pageId = '44444444444444444444444444444444';
    let propertyWrites = 0;
    let contentWrites = 0;

    class MockNotion {
      constructor() {
        this.client = { pages: { update: async () => { propertyWrites++; } } };
      }
      async validateToken() {}
      async getPage(id) {
        return {
          id,
          last_edited_time: '2026-01-01T00:00:00.000Z',
          properties: { title: { type: 'title', title: [{ plain_text: 'Remote title' }] } },
        };
      }
      async getBlockChildren() { throw new Error('pull-only must not preflight writes'); }
      async clearPageContent() { contentWrites++; }
      async appendPageContent() { contentWrites++; }
    }

    const result = await executeSyncMode({
      targets: [{ source: `https://notion.so/${pageId}`, outDir: '.', filename: 'local.md', sync: 'pull-only', title: 'filename' }],
    }, 'offline-token', {}, {
      notionClass: MockNotion,
      prompts: createNoopPrompts(),
      loadStateLedger: () => ({ byNotionId: {}, byPath: {} }),
      saveStateLedger: async () => {},
      downloadPages: async () => ({ writtenFiles: [], errors: [] }),
    });

    assert.equal(result.failedTargets.length, 0);
    assert.equal(propertyWrites, 0);
    assert.equal(contentWrites, 0);
  });
});
