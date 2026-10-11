import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, extractNotionId, getHeadlessExitCode, resolveDiscoverySource } from '../src/cli.js';

test('parseArgs recognizes flags and type', () => {
  const args = parseArgs(['--format', 'flattened', '--out', '/tmp', '--type', 'csv', '--debug']);
  assert.equal(args.format, 'flattened');
  assert.equal(args.out, '/tmp');
  assert.equal(args.type, 'csv');
  assert.equal(args.debug, true);
});

test('parseArgs records explicit discovery source flags', () => {
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

test('getHeadlessExitCode fails when stats contain errors', () => {
  assert.equal(getHeadlessExitCode({ errors: [] }), 0);
  assert.equal(getHeadlessExitCode({ errors: [{ title: 'x', error: 'y' }] }), 1);
});
