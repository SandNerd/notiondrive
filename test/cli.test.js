import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, extractNotionId, getHeadlessExitCode, resolveDiscoverySource } from '../src/cli.js';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

test('parseArgs recognizes flags and type', () => {
  const args = parseArgs(['--format', 'flattened', '--out', '/tmp', '--type', 'csv', '--debug']);
  assert.equal(args.format, 'flattened');
  assert.equal(args.out, '/tmp');
  assert.equal(args.type, 'csv');
  assert.equal(args.debug, true);
});

test('parseArgs records explicit discovery source flags', () => {
  const plan = parseArgs(['plan', '--json']);
  assert.equal(plan.planMode, true);
  const database = parseArgs(['discover', '--database', '0123456789abcdef0123456789abcdef']);
  const dataSource = parseArgs(['discover', '--data-source', 'source-id']);
  assert.equal(database.databaseFlagProvided, true);
  assert.equal(database.dataSourceFlagProvided, undefined);
  assert.equal(dataSource.dataSourceFlagProvided, true);
  assert.equal(parseArgs(['discover', '--database', 'db', '--data-source', 'source']).databaseFlagProvided, true);
  assert.equal(parseArgs(['discover', '--database', 'db', '--data-source', 'source']).dataSourceFlagProvided, true);
});

test('explicit discovery source overrides configured source', () => {
  assert.deepEqual(resolveDiscoverySource(parseArgs(['discover', '--data-source', 'source-x']), { databaseId: 'configured-db' }), { databaseId: null, dataSourceId: 'source-x' });
  assert.deepEqual(resolveDiscoverySource(parseArgs(['discover', '--database', 'db-y']), { dataSourceId: 'configured-source' }), { databaseId: 'db-y', dataSourceId: null });
  assert.match(resolveDiscoverySource(parseArgs(['discover', '--database', 'db', '--data-source', 'source'])).error, /Specify only one/);
});

test('parseArgs preserves token short flag', () => {
  const args = parseArgs(['-t', 'ntn_example_token']);
  assert.equal(args.token, 'ntn_example_token');
});

test('extractNotionId extracts 32 char id or hyphenated', () => {
  const id = extractNotionId('https://notion.so/Page-Title-0123456789abcdef0123456789abcdef');
  assert.equal(id.length, 32);
});

test('discover --json emits exactly one JSON value for missing credentials and explicit tokens', () => {
  const cli = path.resolve('bin/cli.js');
  for (const args of [['discover', '--json'], ['discover', '--json', '--token', 'fake-token']]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, NOTION_TOKEN: '' } });
    assert.notEqual(result.status, 0);
    assert.doesNotThrow(() => JSON.parse(result.stdout));
    assert.equal(result.stdout.trim().startsWith('{') || result.stdout.trim().startsWith('['), true);
    assert.equal(result.stderr.includes('Validating token'), false);
  }
});

test('discover entrypoint never persists explicit tokens or changes local state', () => {
  const cli = path.resolve('bin/cli.js');
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'notiondrive-discovery-'));
  const cwd = path.join(parent, 'repo');
  const home = path.join(parent, 'home');
  fs.mkdirSync(cwd);
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(cwd, 'notiondrive.config.json'), JSON.stringify({ discovery: { databaseId: '0123456789abcdef0123456789abcdef' } }));
  fs.writeFileSync(path.join(cwd, '.notiondrive-state.json'), '{"ledger":"unchanged"}');
  fs.writeFileSync(path.join(cwd, 'keep.md'), 'unchanged');
  fs.mkdirSync(path.join(cwd, 'regular-file-parent'));
  fs.writeFileSync(path.join(cwd, 'regular-file-parent', 'file'), 'unchanged');
  const before = (directory) => fs.readdirSync(directory).sort().map((name) => {
    const filePath = path.join(directory, name);
    return fs.statSync(filePath).isDirectory() ? [name, before(filePath)] : [name, fs.readFileSync(filePath, 'utf8')];
  });
  const initialFiles = before(cwd);
  const configPath = path.join(home, '.notiondrive', 'config.json');
  const fetchStub = path.join(parent, 'fetch-stub.js');
  fs.writeFileSync(fetchStub, `globalThis.fetch = async () => new Response('{"object":"error","message":"unauthorized"}', { status: 401 });\n`);
  try {
    for (const args of [
      ['discover', '--token', 'invalid-token'],
      ['discover', '--json', '--token', 'invalid-token'],
      ['discover', '--database', 'db', '--data-source', 'source', '--token', 'invalid-token'],
      ['plan', '--token', 'invalid-token'],
      ['plan', '--json', '--token', 'invalid-token'],
      ['plan', '--database', 'db', '--data-source', 'source', '--token', 'invalid-token'],
    ]) {
      const result = spawnSync(process.execPath, ['--import', fetchStub, cli, ...args], {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, HOME: home, NOTION_TOKEN: '', NO_COLOR: '1' },
      });
      assert.notEqual(result.status, 0);
      assert.deepEqual(before(cwd), initialFiles);
      assert.equal(fs.existsSync(configPath), false);
      const output = args.includes('--json') ? result.stdout : `${result.stdout}${result.stderr}`;
      assert.doesNotMatch(output, /Token saved|config\.json.*saved|invalid-token/);
      if (args.includes('--json')) assert.doesNotThrow(() => JSON.parse(result.stdout));
      if (!args.includes('--database')) assert.match(output, /API token is invalid/i);
    }
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('plan entrypoint performs production-client discovery without mutating repository state', () => {
  const cli = path.resolve('bin/cli.js');
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'notiondrive-plan-entry-'));
  const cwd = path.join(parent, 'repo');
  const home = path.join(parent, 'home');
  fs.mkdirSync(cwd);
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(cwd, 'docs'));
  fs.writeFileSync(path.join(cwd, 'notiondrive.config.json'), JSON.stringify({ discovery: { databaseId: '0123456789abcdef0123456789abcdef' } }));
  fs.writeFileSync(path.join(cwd, '.notiondrive-state.json'), '{"ledger":"unchanged"}');
  fs.writeFileSync(path.join(cwd, 'docs', 'existing.md'), 'unchanged');
  const git = (args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(git(['init', '-q']).status, 0);
  assert.equal(git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']).status, 0);
  const initial = fs.readdirSync(cwd).sort().map((name) => [name, fs.statSync(path.join(cwd, name)).isFile() ? fs.readFileSync(path.join(cwd, name), 'utf8') : null]);
  const fetchStub = path.join(parent, 'fetch-stub.cjs');
  fs.writeFileSync(fetchStub, `const Module = require('node:module');\nconst originalLoad = Module._load;\nModule._load = function(request, parent, isMain) {\n  if (request === 'node-fetch') { const fetch = async (input) => {\n  const url = String(input);\n  if (url.endsWith('/v1/search')) return new Response(JSON.stringify({ results: [], has_more: false, next_cursor: null }), { status: 200 });\n  if (url.includes('/databases/') && url.endsWith('/query')) return new Response(JSON.stringify({ results: [\n    { id: '01234567-89ab-cdef-0123-456789abcdef', last_edited_time: '2026-01-01T00:00:00.000Z', properties: { Name: { type: 'title', title: [{ plain_text: 'existing.md' }] }, 'Repository Directory': { type: 'select', select: { id: 'dir', name: 'docs' } } } },\n    { id: '11234567-89ab-cdef-0123-456789abcdef', last_edited_time: '2026-01-01T00:00:00.000Z', properties: { Name: { type: 'title', title: [{ plain_text: 'review.md' }] }, 'Repository Directory': { type: 'select', select: null } } }\n  ], has_more: false, next_cursor: null }), { status: 200 });\n  if (url.includes('/blocks/') && url.includes('/children')) return new Response(JSON.stringify({ results: [], has_more: false, next_cursor: null }), { status: 200 });\n  return new Response(JSON.stringify({ object: 'error', message: 'unexpected request' }), { status: 404 });\n  };\n  fetch.default = fetch;\n  return fetch; }\n  return originalLoad.call(this, request, parent, isMain);\n};\n`);
  try {
    const result = spawnSync(process.execPath, ['--require', fetchStub, cli, 'plan', '--json'], { cwd, encoding: 'utf8', env: { ...process.env, HOME: home, NOTIONDRIVE_STATE_FILE: path.join(parent, 'state.json'), NOTION_TOKEN: 'fixture-token', NO_COLOR: '1' } });
    assert.notEqual(result.status, 0, result.stderr);
    assert.notEqual(result.stdout.trim(), '', `Expected plan JSON; stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.error, undefined, result.stdout);
    assert.equal(output.summary.total, 2);
    assert.equal(output.documents.find((row) => row.pageId === '0123456789abcdef0123456789abcdef').path, 'docs/existing.md');
    assert.equal(output.documents.find((row) => row.pageId === '1123456789abcdef0123456789abcdef').classification, 'REQUIRES_REVIEW');
    assert.equal(fs.existsSync(path.join(home, '.notiondrive', 'config.json')), false);
    assert.deepEqual(fs.readdirSync(cwd).sort().map((name) => [name, fs.statSync(path.join(cwd, name)).isFile() ? fs.readFileSync(path.join(cwd, name), 'utf8') : null]), initial);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('getHeadlessExitCode fails when stats contain errors', () => {
  assert.equal(getHeadlessExitCode({ errors: [] }), 0);
  assert.equal(getHeadlessExitCode({ errors: [{ title: 'x', error: 'y' }] }), 1);
});
