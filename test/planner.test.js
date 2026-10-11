import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPlan } from '../src/planner.js';

async function git(root, ...args) {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notiondrive-plan-'));
  try {
    await git(root, 'init', '-q');
    await git(root, 'config', 'user.email', 'test@example.com');
    await git(root, 'config', 'user.name', 'Test');
    await mkdir(path.join(root, 'docs'));
    await writeFile(path.join(root, 'docs/a.md'), 'stable');
    await git(root, 'add', '.');
    await git(root, 'commit', '-qm', 'fixture');
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('reports unknown baseline rather than inferring synchronization from timestamps', async () => {
  await fixture(async (root) => {
    const plan = await createPlan({ root, discoveries: [{ pageId: 'page-1', title: 'A', path: 'docs/a.md', status: 'mapped', provenance: { databaseId: 'db' } }], remotePages: [{ id: 'page-1', last_edited_time: '2024-01-01' }] });
    assert.equal(plan.documents[0].classification, 'UNTRACKED');
    assert.equal(plan.repository.revision.length, 40);
    assert.equal(plan.documents[0].source.id, 'db');
  });
});

test('uses local hash and remote revision to identify local changes and missing files', async () => {
  await fixture(async (root) => {
    const pageId = '90fabd95-e170-82e8-a49f-818c1160f390';
    const baseline = { byNotionId: { [pageId.replace(/-/g, '')]: { outputs: { 'docs/a.md': { last_synced_local_hash: '0'.repeat(64), last_synced_remote_mtime: 'old', last_synced_content_fingerprint: '31e7318a912117348c07bfb0624a482df2afc8d988e6923cfcb408fbf9201587' } } } } };
    const plan = await createPlan({ root, ledgerLoader: async () => baseline, discoveries: [{ pageId, title: 'A', path: 'docs/a.md', status: 'mapped', provenance: { dataSourceId: 'ds' } }], remotePages: [{ id: pageId, last_edited_time: 'old' }], fetchRemoteBlocks: async () => [{ id: 'block', type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'remote' }] } }] });
    assert.equal(plan.documents[0].classification, 'LOCAL_CHANGED');
    assert.equal(plan.documents[0].source.type, 'data_source');
    const absentBaseline = { byNotionId: { 'page-1': { outputs: { 'docs/gone.md': { last_synced_local_hash: 'f379ccb92b9116442dc65bdc35648a85d3786b34779db7f704a901fa07b00cb6', last_synced_remote_mtime: 'old', last_synced_content_fingerprint: '31e7318a912117348c07bfb0624a482df2afc8d988e6923cfcb408fbf9201587' } } } } };
    const absent = await createPlan({ root, ledgerLoader: async () => absentBaseline, discoveries: [{ pageId: 'page-1', title: 'A', path: 'docs/gone.md', status: 'mapped' }], remotePages: [{ id: 'page-1', last_edited_time: 'old' }] });
    assert.equal(absent.documents[0].classification, 'MISSING_LOCAL');
  });
});

test('classifies both-sided edits as conflicts and path changes separately', async () => {
  await fixture(async (root) => {
    const pageId = '90fabd95-e170-82e8-a49f-818c1160f390';
    const baseline = { byNotionId: { [pageId.replace(/-/g, '')]: { outputs: { 'docs/a.md': { last_synced_local_hash: '0'.repeat(64), last_synced_remote_mtime: 'old', last_synced_content_fingerprint: '1'.repeat(64) } } } } };
    const discovery = { pageId, title: 'A', path: 'docs/a.md', status: 'mapped' };
    const changedRemote = [{ id: pageId.replace(/-/g, ''), last_edited_time: 'new', content_fingerprint: '2'.repeat(64) }];
    const conflict = await createPlan({ root, ledgerLoader: async () => baseline, discoveries: [discovery], remotePages: changedRemote });
    assert.equal(conflict.documents[0].classification, 'CONFLICT');
    const moved = await createPlan({ root, ledgerLoader: async () => baseline, discoveries: [{ ...discovery, path: 'docs/renamed.md' }], remotePages: changedRemote });
    assert.equal(moved.documents[0].classification, 'PATH_CHANGED');
  });
});

test('flags RRE instruction retirement and Blueprint restructuring without inferring equivalence', async () => {
  await fixture(async (root) => {
    const titles = [
      ...Array.from({ length: 30 }, (_, index) => `rulesync-${String(index + 1).padStart(2, '0')}.md`),
      'planner.agent.md', 'reviewer.agent.md', 'implementer.agent.md',
      'build.workflow.md', 'test.workflow.md', 'release.workflow.md', 'triage.workflow.md',
      'Part-3A.blueprint.md', 'Part-3B.blueprint.md', 'Part-3C.blueprint.md',
      'Part-3.blueprint.md', 'Part-4.blueprint.md', 'Part-5.blueprint.md',
    ];
    const discoveries = titles.map((title, index) => ({
      pageId: `90fabd95-e170-82e8-a49f-${String(index).padStart(12, '0')}`,
      title, path: `.agents/archive/rulesync-legacy/${title}`, status: 'mapped',
    }));
    const priorTitles = titles.slice(37);
    const byNotionId = Object.fromEntries(discoveries.map((item, index) => [item.pageId, {
      outputs: index < 37 ? {} : { [priorTitles[index - 37]]: {
        last_synced_local_hash: '0'.repeat(64), last_synced_remote_mtime: 'old', last_synced_content_fingerprint: '1'.repeat(64),
      } },
    }]));
    const plan = await createPlan({ root, ledgerLoader: async () => ({ byNotionId }), gitRunner: (repository, args) => args[0] === 'rev-parse' ? 'a'.repeat(40) : '', discoveries, remotePages: discoveries.map(({ pageId }) => ({ id: pageId, last_edited_time: 'new', content_fingerprint: '2'.repeat(64) })) });
    assert.equal(plan.documents.length, 43);
    assert.equal(plan.documents.filter((row) => row.classification === 'UNTRACKED').length, 37);
    assert.equal(plan.documents.filter((row) => row.classification === 'PATH_CHANGED').length, 6);
    assert.ok(plan.documents.every((row) => row.classification !== 'IN_SYNC'));
    assert.ok(plan.documents.every((row) => !row.reason.includes('equivalent')));
  });
});

test('parses NUL-delimited Git renames and recognizes untracked files without treating them as changes', async () => {
  await fixture(async (root) => {
    const oldPath = 'docs/a.md';
    const newPath = 'docs/b.md';
    const pageId = '90fabd95-e170-82e8-a49f-818c1160f390';
    await rename(path.join(root, oldPath), path.join(root, newPath));
    const gitEvidence = `R  ${newPath}\0${oldPath}\0`;
    const gitRunner = (repository, args) => args[0] === 'rev-parse' ? 'a'.repeat(40) : gitEvidence;
    const baseline = { byNotionId: { [pageId]: { outputs: { [oldPath]: { last_synced_local_hash: '0'.repeat(64), last_synced_remote_mtime: 'old', last_synced_content_fingerprint: '1'.repeat(64) } } } } };
    const plan = await createPlan({ root, ledgerLoader: async () => baseline, gitRunner, discoveries: [{ pageId, title: 'A', path: oldPath, status: 'mapped' }], remotePages: [{ id: pageId, last_edited_time: 'old', content_fingerprint: '1'.repeat(64) }] });
    assert.equal(plan.documents[0].classification, 'POSSIBLE_MOVE');
    assert.equal(plan.documents[0].gitEvidence, 'renamed');
  });
});

test('records untracked Git paths as local modification evidence without claiming a sync baseline', async () => {
  await fixture(async (root) => {
    const pageId = '90fabd95-e170-82e8-a49f-818c1160f390';
    await writeFile(path.join(root, 'docs/new.md'), 'new');
    const gitEvidence = `?? docs/new.md\0`;
    const gitRunner = (repository, args) => args[0] === 'rev-parse' ? 'a'.repeat(40) : gitEvidence;
    const plan = await createPlan({ root, ledgerLoader: async () => ({}), gitRunner, discoveries: [{ pageId, title: 'New', path: 'docs/new.md', status: 'mapped' }], remotePages: [{ id: pageId, last_edited_time: 'new', content_fingerprint: '2'.repeat(64) }] });
    assert.equal(plan.documents[0].gitEvidence, 'modified');
    assert.equal(plan.documents[0].local.modified, true);
    assert.equal(plan.documents[0].classification, 'UNTRACKED');
  });
});

test('treats tracked files with local edits as conflicts when Notion changed', async () => {
  await fixture(async (root) => {
    const pageId = '90fabd95-e170-82e8-a49f-818c1160f390';
    const baseline = { byNotionId: { [pageId]: { outputs: { 'docs/a.md': { last_synced_local_hash: '0'.repeat(64), last_synced_remote_mtime: 'old', last_synced_content_fingerprint: '1'.repeat(64) } } } } };
    const gitRunner = (repository, args) => args[0] === 'rev-parse' ? 'a'.repeat(40) : ' M docs/a.md';
    const plan = await createPlan({ root, ledgerLoader: async () => baseline, gitRunner, discoveries: [{ pageId, title: 'A', path: 'docs/a.md', status: 'mapped' }], remotePages: [{ id: pageId, last_edited_time: 'new', content_fingerprint: '2'.repeat(64) }] });
    assert.equal(plan.documents[0].classification, 'CONFLICT');
    assert.equal(plan.documents[0].local.modified, true);
  });
});

test('reports Git deletions and renames as review-only evidence', async () => {
  await fixture(async (root) => {
    const pageId = '90fabd95-e170-82e8-a49f-818c1160f390';
    const baseline = { byNotionId: { [pageId]: { outputs: { 'docs/a.md': { last_synced_local_hash: '0'.repeat(64), last_synced_remote_mtime: 'old', last_synced_content_fingerprint: '1'.repeat(64) } } } } };
    const gitRunner = (repository, args) => args[0] === 'rev-parse' ? 'a'.repeat(40) : ' D docs/a.md';
    const plan = await createPlan({ root, ledgerLoader: async () => baseline, gitRunner, discoveries: [{ pageId, title: 'A', path: 'docs/a.md', status: 'mapped' }], remotePages: [{ id: pageId, last_edited_time: 'old', content_fingerprint: '1'.repeat(64) }] });
    assert.equal(plan.documents[0].classification, 'POSSIBLE_ARCHIVE');
    assert.equal(plan.documents[0].reason.includes('restoration is not inferred'), true);
  });
});

test('reports ambiguous discovery without changing local files or the ledger', async () => {
  await fixture(async (root) => {
    const file = path.join(root, 'docs/a.md');
    const before = await readFile(file, 'utf8');
    let writes = 0;
    const plan = await createPlan({ root, ledgerLoader: async () => ({}) , discoveries: [{ pageId: 'page-1', title: 'A', path: null, status: 'requires_review', reason: 'missing directory' }] });
    assert.equal(plan.documents[0].classification, 'REQUIRES_REVIEW');
    assert.equal(await readFile(file, 'utf8'), before);
    assert.equal(writes, 0);
  });
});
