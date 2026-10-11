import { test } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseArgs, loadLocalManifest } from '../src/cli.js';

test('parseArgs detects sync command', () => {
  const args = parseArgs(['sync']);
  assert.equal(args.syncMode, true);
});

test('parseArgs combines sync with other flags', () => {
  const args = parseArgs(['sync', '--debug', '--format', 'flattened']);
  assert.equal(args.syncMode, true);
  assert.equal(args.debug, true);
  assert.equal(args.format, 'flattened');
});

test('loadLocalManifest returns null when file missing', () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'notiondrive-test-'));
  const originalCwd = process.cwd();
  try {
    process.chdir(tmpDir);
    const manifest = loadLocalManifest();
    assert.equal(manifest, null);
  } finally {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true });
  }
});

test('loadLocalManifest parses valid manifest', () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'notiondrive-test-'));
  const originalCwd = process.cwd();
  try {
    process.chdir(tmpDir);
    const manifest = {
      targets: [
        { source: 'https://notion.so/page1', path: './out1/Page1', format: 'markdown-tree' },
        { source: 'db-id-123', path: './out2', format: 'flattened' },
      ],
    };
    writeFileSync('notiondrive.config.json', JSON.stringify(manifest), 'utf-8');

    const loaded = loadLocalManifest();
    assert.deepEqual(loaded.targets.length, 2);
    assert.equal(loaded.targets[0].source, 'https://notion.so/page1');
    // Backwards compat: loader still exposes filename if present in manifest
    assert.equal(loaded.targets[0].path, './out1/Page1');
    assert.equal(loaded.targets[1].source, 'db-id-123');
  } finally {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true });
  }
});

test('loadLocalManifest throws on invalid JSON', () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'notiondrive-test-'));
  const originalCwd = process.cwd();
  try {
    process.chdir(tmpDir);
    writeFileSync('notiondrive.config.json', 'invalid json{', 'utf-8');

    assert.throws(() => {
      loadLocalManifest();
    }, /Failed to load/);
  } finally {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true });
  }
});

test('loadLocalManifest throws when targets array missing', () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'notiondrive-test-'));
  const originalCwd = process.cwd();
  try {
    process.chdir(tmpDir);
    writeFileSync('notiondrive.config.json', JSON.stringify({ foo: 'bar' }), 'utf-8');

    assert.throws(() => {
      loadLocalManifest();
    }, /Manifest must have a \"targets\" or \"groups\" array/);
  } finally {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true });
  }
});

test('loadLocalManifest flattens grouped targets into unified targets array', () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'notiondrive-test-'));
  const originalCwd = process.cwd();
  try {
    process.chdir(tmpDir);
    const manifest = {
      groups: [
        {
          name: 'docs',
          format: 'markdown-tree',
          targets: [
            { source: 'https://notion.so/pageA', path: './docs/PageA' },
            { source: 'https://notion.so/pageB', path: './docs/PageB', format: 'flattened' }
          ]
        }
      ]
    };
    writeFileSync('notiondrive.config.json', JSON.stringify(manifest), 'utf-8');

    const loaded = loadLocalManifest();
    assert.equal(Array.isArray(loaded.targets), true);
    assert.equal(loaded.targets.length, 2);
    assert.equal(loaded.targets[0].group, 'docs');
    assert.equal(loaded.targets[0].format, 'markdown-tree');
    assert.equal(loaded.targets[1].format, 'flattened');
  } finally {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true });
  }
});
