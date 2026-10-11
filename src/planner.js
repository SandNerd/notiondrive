import crypto from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadStateLedger } from './state.js';

function runGit(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

function canonicalPageId(value) {
  return typeof value === 'string' && /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(value)
    ? value.replace(/-/g, '').toLowerCase()
    : null;
}

function parseGitStatus(status) {
  const fields = status.includes('\0') ? status.split('\0').filter(Boolean) : status.split('\n').filter(Boolean);
  const paths = new Map();
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index];
    const code = entry.slice(0, 2);
    const firstPath = entry.slice(3);
    const isRename = code.includes('R') || code.includes('C');
    const previousPath = isRename ? fields[++index] : null;
    const oldPath = previousPath || firstPath;
    const newPath = previousPath ? firstPath : null;
    const evidence = code.includes('D') ? 'deleted' : isRename ? 'renamed' : 'modified';
    paths.set(oldPath, evidence);
    if (newPath) paths.set(newPath, 'renamed');
  }
  return paths;
}

function ledgerRecords(ledger, pageId) {
  const canonicalId = canonicalPageId(pageId);
  const matchingEntries = Object.entries(ledger?.byNotionId || {}).filter(([id]) => canonicalPageId(id) === canonicalId);
  if (matchingEntries.length > 1) return [{ path: null, record: null }, { path: null, record: null }];
  const entry = matchingEntries[0]?.[1];
  if (!entry || typeof entry !== 'object' || !entry.outputs || typeof entry.outputs !== 'object') return [];
  return Object.entries(entry.outputs).map(([relPath, record]) => ({ path: relPath, record: record || {} }));
}

async function fileSnapshot(root, relativePath) {
  if (!relativePath) return { exists: false, hash: null, error: null };
  if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..')) return { exists: false, hash: null, error: 'unsafe path' };
  const target = path.resolve(root, relativePath);
  const canonicalRoot = await realpath(root);
  if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) return { exists: false, hash: null, error: 'path escapes repository' };
  try {
    const canonicalTarget = await realpath(target);
    if (!canonicalTarget.startsWith(`${canonicalRoot}${path.sep}`)) return { exists: false, hash: null, error: 'path escapes repository through symlink' };
    const metadata = await stat(target);
    if (!metadata.isFile()) return { exists: false, hash: null, error: 'destination is not a regular file' };
    const content = await readFile(target);
    return { exists: true, hash: crypto.createHash('sha256').update(content).digest('hex'), error: null };
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, hash: null, error: null };
    if (error.code === 'ENOTDIR') return { exists: false, hash: null, error: 'a parent path component is not a directory' };
    return { exists: false, hash: null, error: error.message };
  }
}

function fingerprintBlocks(blocks) {
  const content = (items) => items.map(({ children, id, created_time, last_edited_time, created_by, last_edited_by, parent, has_children, ...block }) => ({
    ...block,
    children: content(children || []),
  }));
  return crypto.createHash('sha256').update(JSON.stringify(content(blocks))).digest('hex');
}

function trustedBaseline(record) {
  return typeof record?.last_synced_local_hash === 'string' && /^[a-f0-9]{64}$/i.test(record.last_synced_local_hash)
    && typeof record?.last_synced_remote_mtime === 'string' && record.last_synced_remote_mtime.length > 0;
}

function classify({ discovery, prior, file, remoteRevision, remote, gitEvidence }) {
  if (discovery.status !== 'mapped') return ['REQUIRES_REVIEW', discovery.reason || 'discovery mapping requires review'];
  if (prior.length > 1) return ['REQUIRES_REVIEW', 'multiple ledger paths or page identities exist for this Notion page'];
  const baseline = prior[0]?.record;
  const lastPath = prior[0]?.path || null;
  if (lastPath && lastPath !== discovery.path) return ['PATH_CHANGED', 'Notion-derived path differs from the tracked ledger path; restructuring or a move requires review, and content equivalence is not inferred'];
  if (gitEvidence === 'deleted') return ['POSSIBLE_ARCHIVE', 'tracked path is deleted in Git; restoration is not inferred'];
  if (gitEvidence === 'renamed') return ['POSSIBLE_MOVE', 'Git reports a rename involving the tracked path; content equivalence is not inferred'];
  if (file.error) return ['REQUIRES_REVIEW', `local file cannot be safely inspected: ${file.error}`];
  if (!trustedBaseline(baseline)) return ['UNTRACKED', 'no trustworthy shared synchronization baseline is available'];
  if (!file.exists) return ['MISSING_LOCAL', 'expected local file is absent; no restoration is proposed'];
  if (!remoteRevision) return ['REQUIRES_REVIEW', 'remote revision is unavailable; synchronization state cannot be established'];
  const localChanged = file.hash !== baseline.last_synced_local_hash;
  const baselineFingerprint = baseline.last_synced_content_fingerprint;
  const remoteFingerprint = remote?.content_fingerprint;
  if (!baselineFingerprint || !remoteFingerprint) return ['UNTRACKED', 'remote content fingerprint or its synchronized baseline is unavailable'];
  const remoteChanged = remoteFingerprint !== baselineFingerprint;
  if (localChanged && remoteChanged) return ['CONFLICT', 'local and remote content fingerprints both differ from the last-synchronized baseline'];
  if (localChanged) return ['LOCAL_CHANGED', 'local content hash differs from the last-synchronized baseline'];
  if (remoteChanged) return ['NOTION_CHANGED', 'remote content fingerprint differs from the last-synchronized baseline'];
  return ['IN_SYNC', 'local and remote content fingerprints match their synchronized baselines'];
}

export async function createPlan({ discoveries, root = process.cwd(), ledgerLoader = loadStateLedger, gitRunner = runGit, remotePages = discoveries?.pages || [], fetchRemoteBlocks = null }) {
  const resolvedRoot = await realpath(root);
  const ledger = await ledgerLoader();
  const revision = gitRunner(resolvedRoot, ['rev-parse', 'HEAD']);
  if (!revision) throw new Error('Selected repository is not a readable Git worktree');
  const status = gitRunner(resolvedRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']) || '';
  const changedPaths = parseGitStatus(status);
  const rows = [];
  for (const discovery of discoveries) {
    const pageId = discovery.pageId;
    const prior = ledgerRecords(ledger, pageId);
    const lastPath = prior.length === 1 ? prior[0].path : null;
    const localPath = discovery.path || lastPath;
    const file = await fileSnapshot(resolvedRoot, localPath);
    const canonicalId = canonicalPageId(pageId);
    const matchingPages = canonicalId ? remotePages.filter((page) => canonicalPageId(page?.id) === canonicalId) : [];
    const remote = matchingPages.length === 1 ? matchingPages[0] : null;
    const remoteRevision = remote?.last_edited_time || null;
    let remoteFingerprint = remote?.content_fingerprint || null;
    let remoteContentError = null;
    if (!remoteFingerprint && remote && typeof fetchRemoteBlocks === 'function') {
      try {
        const remoteBlocks = await fetchRemoteBlocks(remote.id);
        if (Array.isArray(remoteBlocks)) remoteFingerprint = fingerprintBlocks(remoteBlocks);
        else remoteContentError = 'remote content response is incomplete';
      } catch (error) {
        remoteContentError = error.message;
      }
    }
    const trackedEvidence = (lastPath && changedPaths.get(lastPath)) || null;
    const gitEvidence = trackedEvidence || (discovery.path && changedPaths.get(discovery.path)) || null;
    const repositoryEvidence = gitEvidence || null;
    const remoteForClassification = remote ? { ...remote, content_fingerprint: remoteFingerprint } : null;
    const [classification, reason] = matchingPages.length > 1
      ? ['REQUIRES_REVIEW', 'multiple remote records share this page identity']
      : remoteContentError
        ? ['REQUIRES_REVIEW', `cannot obtain a complete remote content fingerprint: ${remoteContentError}`]
        : classify({ discovery, prior, file, remoteRevision, remote: remoteForClassification, gitEvidence: repositoryEvidence });
    rows.push({
      pageId: pageId || null,
      source: discovery.provenance?.databaseId ? { type: 'database', id: discovery.provenance.databaseId } : discovery.provenance?.dataSourceId ? { type: 'data_source', id: discovery.provenance.dataSourceId } : null,
      title: discovery.title || '',
      path: discovery.path || null,
      lastSyncedPath: lastPath,
      baseline: prior.length === 1 && trustedBaseline(prior[0].record) ? {
        localHash: prior[0].record.last_synced_local_hash,
        remoteRevision: prior[0].record.last_synced_remote_mtime,
      } : null,
      local: { exists: file.exists, hash: file.hash, modified: gitEvidence === 'modified' },
      remote: { revision: remoteRevision, fingerprint: remoteFingerprint, metadataChanged: prior.length === 1 && remoteRevision !== prior[0].record.last_synced_remote_mtime && remoteFingerprint === prior[0].record.last_synced_content_fingerprint },
      classification,
      reason,
      gitEvidence,
    });
  }
  rows.sort((a, b) => (a.pageId || '').localeCompare(b.pageId || '') || (a.path || '').localeCompare(b.path || ''));
  const counts = Object.fromEntries([...new Set(rows.map((row) => row.classification))].sort().map((key) => [key, rows.filter((row) => row.classification === key).length]));
  return { repository: { identity: path.basename(resolvedRoot), revision }, source: discoveries.source || null, summary: { total: rows.length, classifications: counts }, documents: rows };
}
