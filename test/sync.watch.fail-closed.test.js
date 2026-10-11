import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { startSyncWatchMode } from '../src/sync.js';

function createNoopPrompts() {
  return {
    spinner: () => ({ start: () => {}, stop: () => {}, message: () => {} }),
    log: { info: () => {}, warn: () => {}, error: () => {}, success: () => {} },
  };
}

async function exerciseWatcherFailure({ suffix, initialContent, changedContent, frontmatter, failAt }) {
  const originalCwd = process.cwd();
  const originalSigintListeners = new Set(process.listeners('SIGINT'));
  const dir = await mkdtemp(path.join(tmpdir(), `notiondrive-watch-${suffix}-`));
  const pageId = `${suffix}`.padEnd(32, '0').slice(0, 32);
  const rel = 'watched.md';
  const filePath = path.join(dir, rel);
  const originalHash = createHash('sha256').update(initialContent).digest('hex');
  const ledger = {
    byNotionId: {
      [pageId]: {
        notion_id: pageId,
        outputs: {
          [rel]: {
            last_synced_remote_mtime: '2026-01-01T00:00:00.000Z',
            last_synced_local_hash: originalHash,
          },
        },
      },
    },
    byPath: { [rel]: pageId },
  };
  const savedLedgers = [];
  let propertyWrites = 0;
  let clearCalls = 0;
  let appendCalls = 0;
  let onChange;
  let closeWatcher;

  class MockNotion {
    constructor() {
      this.client = {
        pages: {
          update: async () => {
            propertyWrites++;
            if (failAt === 'property' || failAt === 'title') throw new Error('property update failed');
          },
        },
      };
    }
    async validateToken() {}
    async getPage(id) {
      return {
        id,
        last_edited_time: '2026-01-01T00:00:00.000Z',
        properties: { title: { type: 'title', title: [{ plain_text: 'Original' }] } },
      };
    }
    async getBlockChildren() {
      if (failAt === 'preflight') throw new Error('block read failed');
      return [];
    }
    async clearPageContent() { clearCalls++; }
    async appendPageContent() {
      appendCalls++;
      if (failAt === 'append') throw new Error('append failed');
      return 1;
    }
  }

  const prompts = createNoopPrompts();
  try {
    process.chdir(dir);
    await writeFile(filePath, initialContent, 'utf8');
    const manifest = {
      targets: [{
        source: `https://notion.so/${pageId}`,
        outDir: '.',
        filename: rel,
        sync: 'push-only',
        ...(frontmatter ? { frontmatter } : {}),
      }],
    };

    await startSyncWatchMode(manifest, 'offline-token', {}, {
      notionClass: MockNotion,
      prompts,
      loadStateLedger: async () => structuredClone(ledger),
      saveStateLedger: async (state) => savedLedgers.push(structuredClone(state)),
      watch: (_directory, callback) => {
        onChange = callback;
        closeWatcher = () => {};
        return { close: closeWatcher };
      },
    });

    assert.equal(typeof onChange, 'function');
    await writeFile(filePath, changedContent, 'utf8');
    onChange('change', rel);
    await new Promise((resolve) => setTimeout(resolve, 700));

    const succeeded = failAt === 'none';
    assert.equal(propertyWrites > 0, failAt === 'property' || failAt === 'title' || succeeded);
    assert.equal(clearCalls, failAt === 'append' || succeeded ? 1 : 0);
    assert.equal(appendCalls, failAt === 'append' || succeeded ? 1 : 0);
    assert.equal(savedLedgers.length, succeeded ? 2 : 1);
    assert.equal(
      savedLedgers.at(-1).byNotionId[pageId].outputs[rel].last_synced_local_hash,
      succeeded ? createHash('sha256').update(changedContent).digest('hex') : originalHash,
      succeeded ? 'successful watcher push should advance the local hash baseline' : 'watcher failure must not advance the local hash baseline'
    );
  } finally {
    closeWatcher?.();
    for (const listener of process.listeners('SIGINT')) {
      if (!originalSigintListeners.has(listener)) process.removeListener('SIGINT', listener);
    }
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true });
  }
}

test('watcher refuses property writes when block preflight fails', async () => {
  await exerciseWatcherFailure({
    suffix: '10000000',
    initialContent: '---\nDescription: original\n---\nBody\n',
    changedContent: '---\nDescription: changed\n---\nBody\n',
    frontmatter: 'Description',
    failAt: 'preflight',
  });
});

test('watcher does not clear content or advance baseline when a property write fails', async () => {
  await exerciseWatcherFailure({
    suffix: '20000000',
    initialContent: '---\nDescription: original\n---\nBody\n',
    changedContent: '---\nDescription: changed\n---\nBody\n',
    frontmatter: 'Description',
    failAt: 'property',
  });
});

test('watcher does not advance baseline when an H1 title write fails', async () => {
  await exerciseWatcherFailure({
    suffix: '30000000',
    initialContent: '## Existing section\n',
    changedContent: '# Updated title\nBody\n',
    failAt: 'title',
  });
});

test('watcher does not advance baseline after a partial content append', async () => {
  await exerciseWatcherFailure({
    suffix: '40000000',
    initialContent: '# Original\n',
    changedContent: '## Updated content\n',
    failAt: 'append',
  });
});

test('watcher syncs a changed H1 and advances baseline after all writes succeed', async () => {
  await exerciseWatcherFailure({
    suffix: '50000000',
    initialContent: '# Original\n',
    changedContent: '# Updated title\nBody\n',
    failAt: 'none',
  });
});
