import path from 'node:path';
import os from 'node:os';
import * as p from '@clack/prompts';
import { wrapError, formatErrorForLogging } from './error.js';
const debug = process.env.DEBUG === '1' || process.env.DEBUG === 'true';
function _debugLog(err) { if (!debug || !err) return; try { p.log.info(formatErrorForLogging(err, { debug: true })); } catch (e) {} }
import { NotionClient } from './notion.js';
import { extractTitle, extractDatabaseTitle } from './notion-helpers.js';
import { downloadPages } from './download.js';
import { isWritablePath, slugifyFilename } from './utils.js';
import { extractNotionId } from './cli.js';
import { loadStateLedger, saveStateLedger, calculateFileHash } from './state.js';
import { markdownToNotionBlocks } from './parser.js';
import fs from 'node:fs/promises';
import { watch } from 'node:fs';

// Normalize a manifest `target` so that a new `path` field is converted
// into the legacy `outDir` and `filename` fields used throughout the code.
function normalizeTarget(t) {
  if (!t) return t;
  if (typeof t.path === 'string' && String(t.path).trim()) {
    const raw = String(t.path).trim();
    const ext = path.extname(raw);
    if (ext) {
      t.outDir = path.dirname(raw) || '.';
      t.filename = path.basename(raw);
    } else {
      t.outDir = raw || '.';
      if (t.filename === undefined) delete t.filename;
    }
  }
  return t;
}

// Helper: locate manifest entries that resolve to a given absolute local path.
async function getManifestEntriesForPath(absoluteLocalPath) {
  const results = [];
  const candidates = [
    { name: 'project', path: path.resolve(process.cwd(), 'notiondrive.config.json') },
    { name: 'user', path: path.join(os.homedir(), '.notiondrive', 'config.json') },
  ];

  for (const c of candidates) {
    try {
      const raw = await fs.readFile(c.path, 'utf-8');
      const parsed = JSON.parse(raw);
      const targets = parsed && Array.isArray(parsed.targets) ? parsed.targets : [];
      const matches = [];
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        if (!t) continue;
        try {
          normalizeTarget(t); // Centralize parsing
          const pageId = extractNotionId(t.source || '');
          const targetFilename = t.filename || `${slugifyFilename(t.name || pageId)}.md`;
          const expandedOutDir = t.outDir && t.outDir.startsWith('~') 
            ? path.join(process.env.HOME || os.homedir(), t.outDir.slice(1)) 
            : t.outDir;
          
          const absPath = path.resolve(expandedOutDir || process.cwd(), targetFilename);
          if (absPath === absoluteLocalPath) {
            matches.push({ 
              index: i, 
              name: t.name || '<no-name>', 
              filename: targetFilename, 
              outDir: t.outDir || '<none>', 
              source: t.source || '<none>' 
            });
          }
        } catch (err) { _debugLog(err); }
      }
      if (matches.length > 0) results.push({ manifestPath: c.path, matches });
    } catch (err) {
      // missing/invalid manifest — ignore
    }
  }

  return results;
}

async function preflightRemoteWrite(notion, pageId, onBlocked) {
  const blocks = await notion.getBlockChildren(pageId);
  if (!Array.isArray(blocks)) {
    throw new Error('Could not verify the Notion canvas before writing');
  }

  const hasRichStructures = blocks.some(
    (block) => block && (block.type === 'child_database' || block.type === 'synced_block')
  );
  if (!hasRichStructures) return blocks;

  if (process.argv.includes('--force') || process.argv.includes('-f')) {
    console.log('[SAFETY] Remote rich structures detected, but --force flag is active. Proceeding with push.');
    return blocks;
  }

  onBlocked?.();
  return false;
}

async function updateNotionTitle(notion, pageId, title) {
  const page = await notion.getPage(pageId);
  const titleKey = Object.entries(page?.properties || {}).find(([, prop]) => prop?.type === 'title')?.[0] || 'title';
  await notion.client.pages.update({
    page_id: pageId,
    properties: {
      [titleKey]: {
        title: [{ type: 'text', text: { content: title } }],
      },
    },
  });
}

function hasExplicitTitle(target) {
  return target?.title === 'filename' || target?.title === 'relativePath';
}

function shouldDemoteCloudTitle({ oldTitle, desiredTitle, target, localContent, uploadContent }) {
  if (!oldTitle || oldTitle === desiredTitle) return false;
  const demotionHeader = `# ${oldTitle}`;
  if (uploadContent.split('\n').some((line) => line.trim() === demotionHeader)) return false;
  if (typeof target.frontmatter !== 'string') return true;

  const frontmatter = extractLeadingFrontmatter(localContent);
  const value = frontmatter?.raw
    ? extractFrontmatterKeyValue(frontmatter.raw, target.frontmatter)
    : null;
  return value == null || String(oldTitle) !== String(value);
}

async function prepareExplicitTitleContent({ notion, pageId, target, localContent, localOutputPath, uploadContent }) {
  const desiredTitle = target.title === 'relativePath'
    ? (target.relativePath || target.filename || path.basename(localOutputPath))
    : (target.filename || path.basename(localOutputPath));
  const oldTitle = extractTitle(await notion.getPage(pageId));

  if (shouldDemoteCloudTitle({ oldTitle, desiredTitle, target, localContent, uploadContent })) {
    uploadContent = `# ${oldTitle}\n\n${uploadContent}`;
  }
  if (oldTitle !== desiredTitle) await updateNotionTitle(notion, pageId, desiredTitle);
  return uploadContent;
}

async function prepareH1TitleContent({ notion, pageId, uploadContent }) {
  const lines = uploadContent.split('\n');
  const headingIndex = lines.findIndex((line) => line.trim());
  if (headingIndex < 0 || !lines[headingIndex].trim().startsWith('# ')) return uploadContent;

  const extractedTitle = lines[headingIndex].trim().slice(2).trim();
  if (extractTitle(await notion.getPage(pageId)) !== extractedTitle) {
    await updateNotionTitle(notion, pageId, extractedTitle);
  }
  return lines.filter((_, index) => index !== headingIndex).join('\n');
}

async function prepareUploadContent({ notion, pageId, target, localContent, localOutputPath }) {
  const uploadContent = stripLeadingFrontmatter(
    await applyFrontmatterTarget(notion, pageId, target, localContent)
  );
  const options = { notion, pageId, target, localContent, localOutputPath, uploadContent };
  return hasExplicitTitle(target)
    ? prepareExplicitTitleContent(options)
    : prepareH1TitleContent(options);
}

async function saveLedgerBaseline(ledger, pageId, relKey, record, saveStateLedgerFn) {
  const updatedLedger = structuredClone(ledger || { byNotionId: {}, byPath: {} });
  updatedLedger.byNotionId = updatedLedger.byNotionId || {};
  updatedLedger.byPath = updatedLedger.byPath || {};
  updatedLedger.byNotionId[pageId] = updatedLedger.byNotionId[pageId] || { notion_id: pageId, outputs: {} };
  const outputs = updatedLedger.byNotionId[pageId].outputs || {};
  updatedLedger.byNotionId[pageId].outputs = outputs;
  outputs[relKey] = { ...(outputs[relKey] || {}), ...record };
  updatedLedger.byPath[relKey] = pageId;

  await saveStateLedgerFn(updatedLedger);
  for (const key of Object.keys(ledger)) delete ledger[key];
  Object.assign(ledger, updatedLedger);
}

async function pushLocalFileToNotion({ notion, pageId, targetItem, target, localOutputPath, currentLocalHash, ledger, saveStateLedgerFn }) {
  const localContent = await fs.readFile(localOutputPath, 'utf-8');
  const remoteBlocks = await preflightRemoteWrite(notion, pageId, () => {
    console.warn(`[SAFETY BYPASS] Aborting push for target page ID "${pageId}". The Notion canvas contains a live child_database or synced_block element that would be flattened into static text. Run the command with the '--force' flag to confirm this overwrite.`);
  });
  if (!remoteBlocks) return null;

  const uploadContent = await prepareUploadContent({ notion, pageId, target, localContent, localOutputPath });
  const blocks = markdownToNotionBlocks(uploadContent, localOutputPath);
  await notion.clearPageContent(pageId);
  const appended = await notion.appendPageContent(pageId, blocks);
  const refreshedPage = await notion.getPage(pageId);
  const newRemoteMtime = refreshedPage?.last_edited_time || targetItem.remoteMtime || null;
  const relKey = path.relative(process.cwd(), localOutputPath);
  const priorRecord = ledger.byNotionId?.[pageId]?.outputs?.[relKey] || {};

  await saveLedgerBaseline(ledger, pageId, relKey, {
    last_synced_remote_mtime: newRemoteMtime,
    last_synced_local_hash: currentLocalHash,
    hasSyncedBlocks: priorRecord.hasSyncedBlocks || false,
    dependencies: Array.isArray(priorRecord.dependencies) ? priorRecord.dependencies : [],
  }, saveStateLedgerFn);
  return appended;
}

function fetchDependencySnapshot(notion, dependency) {
  if (!dependency || !dependency.id || !dependency.type) return null;
  if (dependency.type === 'page') return notion.getPage(dependency.id);
  if (dependency.type === 'database') return notion.getDatabase(dependency.id);
  if (dependency.type === 'block') return notion.getBlock(dependency.id);
  return null;
}

async function dependenciesChanged(notion, dependencies) {
  if (!Array.isArray(dependencies) || dependencies.length === 0) return false;

  const snapshots = await Promise.all(dependencies.map(async (dependency) => {
    try {
      const live = await fetchDependencySnapshot(notion, dependency);
      return {
        dependency,
        liveMtime: live?.last_edited_time || null,
        changed: String(live?.last_edited_time || null) !== String(dependency.mtime || null),
      };
    } catch (err) {
      _debugLog(err);
      return { dependency, liveMtime: null, changed: true };
    }
  }));

  return snapshots.some((snapshot) => snapshot.changed);
}

function extractLeadingFrontmatter(localContent) {
  if (typeof localContent !== 'string' || !localContent.startsWith('---')) {
    return null;
  }

  const match = localContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return null;
  }

  return {
    raw: match[1],
    body: localContent.slice(match[0].length),
  };
}

function stripLeadingFrontmatter(localContent) {
  if (typeof localContent !== 'string') return localContent;
  const fm = extractLeadingFrontmatter(localContent);
  return fm ? fm.body : localContent;
}

function extractFrontmatterKeyValue(frontmatterRaw, key) {
  if (typeof frontmatterRaw !== 'string' || typeof key !== 'string' || !key.trim()) return null;
  const keyLower = key.trim().toLowerCase();
  const lines = frontmatterRaw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^([A-Za-z0-9_-]+)\s*:\s*(.+)$/);
    if (!m) continue;
    const k = String(m[1]).trim().toLowerCase();
    if (k !== keyLower) continue;
    let v = String(m[2]).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    return v;
  }
  return null;
}

async function applyFrontmatterTarget(notion, pageId, target, localContent) {
  const frontmatter = extractLeadingFrontmatter(localContent);

  if (frontmatter && typeof target?.frontmatter === 'string') {
    if (!notion?.client?.pages?.update) {
      throw new Error('Notion client does not support frontmatter injection');
    }

    // Notion API enforces a ~2000 char limit on rich_text segments. Split
    // long frontmatter content into multiple text objects to avoid API
    // validation errors when the frontmatter is large.
    const MAX = 2000;
    const raw = String(frontmatter.raw || '');
    const chunks = [];
    if (raw.length <= MAX) {
      chunks.push(raw);
    } else {
      const lines = raw.split('\n');
      let current = '';
      for (const line of lines) {
        const next = current ? current + '\n' + line : line;
        if (next.length > MAX) {
          if (current) {
            chunks.push(current);
            current = line;
            if (current.length > MAX) {
              let start = 0;
              while (start < current.length) {
                chunks.push(current.slice(start, start + MAX));
                start += MAX;
              }
              current = '';
            }
          } else {
            let start = 0;
            while (start < line.length) {
              chunks.push(line.slice(start, start + MAX));
              start += MAX;
            }
            current = '';
          }
        } else {
          current = next;
        }
      }
      if (current) chunks.push(current);
    }

    const extractedValue = extractFrontmatterKeyValue(frontmatter.raw, target.frontmatter);
    const yamlOrValue = extractedValue != null ? extractedValue : raw;

    const chunksFromYamlOrValue = [];
    const yamlOrValueStr = String(yamlOrValue || '');
    if (yamlOrValueStr.length <= MAX) {
      chunksFromYamlOrValue.push(yamlOrValueStr);
    } else {
      const lines = yamlOrValueStr.split('\n');
      let current = '';
      for (const line of lines) {
        const next = current ? current + '\n' + line : line;
        if (next.length > MAX) {
          if (current) {
            chunksFromYamlOrValue.push(current);
            current = line;
          } else {
            let start = 0;
            while (start < line.length) {
              chunksFromYamlOrValue.push(line.slice(start, start + MAX));
              start += MAX;
            }
          }
        } else {
          current = next;
        }
      }
      if (current) chunksFromYamlOrValue.push(current);
    }

    const rich_text = chunksFromYamlOrValue.map((c) => ({ type: 'text', text: { content: c } }));
    await notion.client.pages.update({
      page_id: pageId,
      properties: {
        [target.frontmatter]: {
          rich_text,
        },
      },
    });
  }

  // Frontmatter should never be included in the pushed page body.
  // If `frontmatter` is configured as a string, it is injected into that
  // Notion property above. Otherwise it is ignored.
  return frontmatter ? frontmatter.body : localContent;
}

/**
 * Execute batch sync from manifest targets
 */
export async function executeSyncMode(manifest, token, args, overrides = {}) {
  const prompts = overrides.prompts || p;

  // Manifest integrity guardrail: detect duplicate local outputs or multiple
  // targets mapping to the same Notion ID with different filenames. Run this
  // before doing any network work to avoid partial or destructive runs.
  try {
    const targets = (manifest && Array.isArray(manifest.targets)) ? manifest.targets : [];
    // Ensure any new `path` fields are normalized via module-level helper
    const seenLocalPaths = new Set();
    const seenNotionIds = new Map();
    for (const target of targets) {
      normalizeTarget(target);
      if (!target || target.disabled) continue;
      let pageId = null;
      try {
        pageId = extractNotionId(target.source);
      } catch (err) {
        // Ignore invalid source here; it will be caught later during per-target
        // validation when executing the sync loop.
        continue;
      }

      const targetFilename = target.filename || `${slugifyFilename(target.name || pageId)}.md`;
      const rawOutDir = target.outDir || process.cwd();
      const expandedOutDir = rawOutDir && rawOutDir.startsWith('~') ? path.join(process.env.HOME || os.homedir(), rawOutDir.slice(1)) : rawOutDir;
      const absoluteLocalPath = path.resolve(expandedOutDir || process.cwd(), targetFilename);

      if (seenLocalPaths.has(absoluteLocalPath)) {
        // Try to provide helpful origin info by scanning known manifest locations
        const origins = await getManifestEntriesForPath(absoluteLocalPath);
        let detailMsg = '\n';
        if (origins.length > 0) {
          detailMsg += 'Conflicting definitions found:';
          for (const o of origins) {
            const idxs = o.matches.map((m) => m.index).join(', ');
            detailMsg += `\n - ${o.manifestPath}: targets[${idxs}]`;
            for (const m of o.matches) {
              detailMsg += `\n    - index ${m.index}: name=${m.name}, filename=${m.filename}, outDir=${m.outDir}, source=${m.source}`;
            }
          }
        } else {
          detailMsg += 'No manifest files located to show origins.';
        }

        prompts.log.error(`[CONFIG ERROR] Manifest target collision detected. Multiple targets are mapped to write to the same local file destination: "${absoluteLocalPath}". Sync aborted to protect local assets.${detailMsg}`);
        return { completedTargets: [], failedTargets: [{ target, error: 'Local path collision' }] };
      }
      seenLocalPaths.add(absoluteLocalPath);

      if (pageId && seenNotionIds.has(pageId) && seenNotionIds.get(pageId) !== targetFilename) {
        // Provide helpful origin information where possible
        const priorFilename = seenNotionIds.get(pageId);
        let detailMsg = `\n - existing mapping: ${priorFilename}\n - current mapping: ${targetFilename}`;
        try {
          // attempt to enumerate manifests that map this pageId to filenames
          const candidates = [path.resolve(process.cwd(), 'notiondrive.config.json'), path.join(os.homedir(), '.notiondrive', 'config.json')];
          const found = [];
          for (const cpath of candidates) {
            try {
              const raw = await fs.readFile(cpath, 'utf-8');
              const parsed = JSON.parse(raw);
              const targets = parsed && Array.isArray(parsed.targets) ? parsed.targets : [];
              for (let i = 0; i < targets.length; i++) {
                const t = targets[i];
                if (!t) continue;
                try {
                  const pid = extractNotionId(t.source || '');
                  if (String(pid) === String(pageId)) {
                    let fn;
                    if (typeof t.path === 'string' && String(t.path).trim()) {
                      const pth = String(t.path).trim();
                      const ext = path.extname(pth);
                      fn = ext ? path.basename(pth) : `${slugifyFilename(t.name || pid)}.md`;
                    } else {
                      fn = t.filename || `${slugifyFilename(t.name || pid)}.md`;
                    }
                    found.push({ manifestPath: cpath, index: i, filename: fn, name: t.name || '<no-name>' });
                  }
                } catch (err) { _debugLog(err); }
              }
            } catch (err) { _debugLog(err); }
          }
          if (found.length > 0) {
            detailMsg += '\nConflicting definitions found in manifests:';
            for (const f of found) {
              detailMsg += `\n - ${f.manifestPath}: targets[${f.index}] -> filename=${f.filename} (name=${f.name})`;
            }
          }
        } catch (err) {
          // ignore
        }

        prompts.log.error(`[CONFIG ERROR] Resource mapping collision detected. Notion page ID "${pageId}" is mapped to two separate local file outputs ("${seenNotionIds.get(pageId)}" and "${targetFilename}"). Sync aborted to prevent cloud asset clobbering.${detailMsg}`);
        return { completedTargets: [], failedTargets: [{ target, error: 'Notion resource collision' }] };
      }
      if (pageId) seenNotionIds.set(pageId, targetFilename);
    }
  } catch (err) {
    // Non-fatal: guardrail failures should not block sync unless they explicitly
    // detected a collision and returned above. Continue if an unexpected error
    // occurred during the preflight.
    _debugLog(err);
  }

  try {
    process.stdin.setMaxListeners(0);
  } catch (err) {}

  // Validate token
  if (!token) {
    prompts.log.error('No Notion token found. Set NOTION_TOKEN or save a token with the CLI (notiondrive --token <token>).');
    return { completedTargets: [], failedTargets: [{ target: null, error: 'No Notion token' }] };
  }

  // Connect and validate
  const spin = prompts.spinner();
  spin.start('Connecting to Notion...');
  const NotionClass = overrides.notionClass || NotionClient;
  const downloadFn = overrides.downloadPages || downloadPages;
  const loadStateLedgerFn = overrides.loadStateLedger || loadStateLedger;
  const saveStateLedgerFn = overrides.saveStateLedger || saveStateLedger;

  // Allow passing a mock notion client directly
  const notion = overrides.notion || new NotionClass(token);
  try {
    if (!overrides.notion) {
      await notion.validateToken();
    }
    spin.stop('Connected to Notion.');
  } catch (err) {
    spin.stop('Connection failed.');
    prompts.log.error(
      err.status === 401
        ? 'Invalid token. Make sure you copied the "Internal Integration Secret", not the Integration ID.'
        : 'Could not connect to Notion. Check your internet connection and try again.'
    );
    return { completedTargets: [], failedTargets: [{ target: null, error: 'Connection failed' }] };
  }

  // Process each target (apply optional filters before network calls)
  let targets = manifest.targets || [];

  // If filtering requested, apply name/group filters before processing
  const syncFilter = args?.syncFilter || null;
  const groupFilter = args?.groupFilter || null;

  if (syncFilter || groupFilter) {
    let filtered = targets;
    let filterPageId = null;
    let filterAbsoluteLocalPath = null;
    let isFilterDirectory = false;

    if (syncFilter) {
      filterPageId = extractNotionId(syncFilter);
      filterAbsoluteLocalPath = path.resolve(process.cwd(), syncFilter);
      try {
        const stats = await fs.stat(filterAbsoluteLocalPath);
        if (stats.isDirectory()) {
          isFilterDirectory = true;
        }
        // Normalize via realpath to eliminate symlink or trailing slash discrepancies
        filterAbsoluteLocalPath = await fs.realpath(filterAbsoluteLocalPath);
      } catch {
        isFilterDirectory = false;
      }
    }

    // Use an async-aware predicate so we can `realpath` target dirs when needed
    filtered = await (async () => {
      const checks = await Promise.all(filtered.map(async (t) => {
        if (!t) return false;
        if (groupFilter && t.group !== groupFilter) return false;
        if (!syncFilter) return true;

        // Ensure targets expressed via `path` (e.g. from group path + relativePath)
        // are normalized into legacy `outDir`/`filename` before we compute matches.
        normalizeTarget(t);

        const targetPageId = extractNotionId(t.source || '');
        const targetFilename = t.filename || `${slugifyFilename(t.name || targetPageId)}.md`;

        // Resolve and expand target directory
        const rawOutDir = t.outDir || process.cwd();
        const expandedOutDir = rawOutDir && typeof rawOutDir === 'string' && rawOutDir.startsWith('~')
          ? path.join(process.env.HOME || os.homedir(), rawOutDir.slice(1))
          : rawOutDir;

        let targetDirAbsolute = path.resolve(expandedOutDir || process.cwd());
        // Enforce realpath symmetry to prevent macOS path-matching failures:
        try {
          if (isFilterDirectory) {
            targetDirAbsolute = await fs.realpath(targetDirAbsolute);
          }
        } catch (err) { _debugLog(err); }

        if (isFilterDirectory) {
          try {
            const rel = path.relative(filterAbsoluteLocalPath, targetDirAbsolute);
            if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
              return true;
            }
          } catch (err) { _debugLog(err); }
          return t.group === syncFilter;
        }

        const targetAbsoluteLocalPath = path.resolve(targetDirAbsolute, targetFilename);

        // Allow flexible matching: exact page/url, notion id, exact path,
        // directory containment (handled above), filename/name prefix, or group.
        const filenameMatches = typeof t.filename === 'string' && (t.filename === syncFilter || t.filename.startsWith(syncFilter));
        const nameMatches = typeof t.name === 'string' && (t.name === syncFilter || String(t.name).toLowerCase().startsWith(String(syncFilter).toLowerCase()));
        let pathPrefixMatches = false;
        try {
          if (typeof filterAbsoluteLocalPath === 'string' && typeof targetAbsoluteLocalPath === 'string') {
            pathPrefixMatches = targetAbsoluteLocalPath === filterAbsoluteLocalPath || targetAbsoluteLocalPath.startsWith(filterAbsoluteLocalPath);
          }
        } catch (err) { _debugLog(err); }

        return (
          t.source === syncFilter ||
          targetPageId === filterPageId ||
          pathPrefixMatches ||
          filenameMatches ||
          t.group === syncFilter ||
          nameMatches
        );
      }));
      return filtered.filter((_, i) => checks[i]);
    })();

    if (!filtered || filtered.length === 0) {
      const filterText = syncFilter || groupFilter || '';
      prompts.log.warn(`No sync targets found matching filter: "${filterText}".`);
      spin.stop('Batch sync complete.');
      return { completedTargets: [], failedTargets: [] };
    }
    targets = filtered;
  }
  // Remove any targets explicitly marked as disabled in the manifest
  const disabledTargets = targets.filter((t) => t && t.disabled === true);
  if (disabledTargets.length > 0) {
    prompts.log.info(`Skipping ${disabledTargets.length} disabled target${disabledTargets.length === 1 ? '' : 's'} from manifest.`);
    targets = targets.filter((t) => !(t && t.disabled === true));
  }
  if (targets.length === 0) {
    prompts.log.warn('No targets found in notiondrive.config.json');
    return { completedTargets: [], failedTargets: [] };
  }

  spin.start(`Processing ${targets.length} target${targets.length === 1 ? '' : 's'}...`);

  const completedTargets = [];
  const failedTargets = [];

  // Load or initialize local state ledger (unless no-cache requested)
  const useLedger = !args?.noCache;
  let ledger;
  if (useLedger) {
    try {
      ledger = await loadStateLedgerFn();
    } catch {
      ledger = { byNotionId: {}, byPath: {} };
    }
  } else {
    ledger = { byNotionId: {}, byPath: {} };
  }
  // Work on a clone of the loaded ledger to avoid mutating external references
  if (useLedger && ledger && typeof ledger === 'object') {
    try {
      ledger = JSON.parse(JSON.stringify(ledger));
    } catch (err) {
      // If cloning fails, fall back to using the original ledger object
    }
  }

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    const prefix = `[${i + 1}/${targets.length}]`;

    // Sanitize and validate the source
    if (!target.source || typeof target.source !== 'string' || !target.source.trim()) {
      failedTargets.push({ target, error: 'Missing source' });
      continue;
    }

    let pageId;
    try {
      pageId = extractNotionId(target.source);
    } catch (err) {
      failedTargets.push({ target, error: `Invalid source: ${err.message}` });
      continue;
    }

    const identifier = target.name || target.filename || pageId;

    // Used for desiredTitle selection when aligning titles for `title: "filename"`.
    // It is populated later when we resolve the matching local output file.
    let resolvedCandidate = null;

    // Fetch page/database info
    let targetItem;
    try {
      let page;
      try {
        page = await notion.getPage(pageId);
      } catch {
        page = null;
      }

      if (page) {
        let name = extractTitle(page) || 'Exported-Page';

        if (target?.title === 'filename' || target?.title === 'relativePath') {
          resolvedCandidate = null;
          if (!target?.filename) {
            // Resolve the local output candidate early so desiredTitle can match the actual file basename.
            const rawOutDir = target.outDir || process.cwd();
            const expandedOutDir = rawOutDir.startsWith('~') ? path.join(process.env.HOME || os.homedir(), rawOutDir.slice(1)) : rawOutDir;
            const outDir = path.resolve(expandedOutDir);

            const slugName = slugifyFilename(name);
            const candidatePathsToProbe = [
              path.join(outDir, `${slugName}.md`),
              path.join(outDir, slugName, `${slugName}.md`),
              path.join(outDir, `${slugName}.csv`),
            ];

            for (const candidate of candidatePathsToProbe) {
              try {
                await fs.stat(candidate);
                resolvedCandidate = { candidate };
                break;
              } catch {
                continue;
              }
            }
          }

          let desiredTitle;
          if (target?.title === 'relativePath') {
            desiredTitle = target.relativePath || target.filename || name;
          } else {
            desiredTitle = target?.filename || (resolvedCandidate ? path.basename(resolvedCandidate.candidate) : `${slugifyFilename(name)}.md`);
          }
          const currentCloudTitle = name;

          if (currentCloudTitle !== desiredTitle) {
            name = desiredTitle;
            if (target.sync === 'push-only' || target.sync === 'two-way') {
              const children = await preflightRemoteWrite(notion, pageId, () => {
                prompts.log.warn(`[SAFETY] Aborting title alignment for ${identifier}; remote Notion canvas contains child_database or synced_block.`);
              });
              if (!children) {
                completedTargets.push({
                  target,
                  item: { id: pageId, name, type: 'page', customFilename: target.filename, remoteMtime: page.last_edited_time || null },
                  skipped: true,
                  reason: 'safety-bypass',
                });
                continue;
              }
              const first = children[0] || null;
              const firstTitle = first?.type === 'heading_1'
                ? (first.heading_1?.rich_text || []).map((text) => text?.plain_text || text?.text?.content || '').join('')
                : '';
              if (!first || firstTitle !== currentCloudTitle) {
                const demotionBlock = markdownToNotionBlocks(`# ${currentCloudTitle}`, `notiondrive-${pageId}.md`)[0];
                await notion.clearPageContent(pageId);
                await notion.appendPageContent(pageId, [demotionBlock, ...children]);
              }

              await updateNotionTitle(notion, pageId, desiredTitle);
            }
          }
        }

        const remoteMtime = (target.sync === 'push-only') ? null : page?.last_edited_time || null;
        targetItem = { id: pageId, name, type: 'page', customFilename: target.filename, remoteMtime };
      } else {
        const db = await notion.getDatabase(pageId);
        const name = extractDatabaseTitle(db) || 'Exported-Database';
        const remoteMtime = (target.sync === 'push-only') ? null : db?.last_edited_time || null;
        targetItem = { id: pageId, name, type: 'database', customFilename: target.filename, remoteMtime };
      }
    } catch (err) {
      failedTargets.push({ target, error: `Could not fetch: ${err.message}` });
      continue;
    }

    // Resolve output directory (expand tilde)
    const rawOutDir = target.outDir || process.cwd();
    const expandedOutDir = rawOutDir.startsWith('~') ? path.join(process.env.HOME || os.homedir(), rawOutDir.slice(1)) : rawOutDir;
    const outDir = path.resolve(expandedOutDir);
    if (!(await isWritablePath(outDir))) {
      failedTargets.push({ target, error: `Cannot write to ${outDir}` });
      continue;
    }

    // Determine expected main output filename.
    // If the user provided an explicit `filename` in the manifest, preserve it
    // (including extension) as the primary candidate. Otherwise, generate a
    // slugified base name and look for .md/.csv variants.
    const providedFilename = typeof target.filename === 'string' && target.filename.trim() ? target.filename.trim() : null;
    let slugName;
    let candidatePaths = [];
    if (providedFilename) {
      const ext = path.extname(providedFilename).toLowerCase();
      const base = ext ? path.basename(providedFilename, ext) : providedFilename;
      slugName = base;
      if (ext) {
        candidatePaths = [
          path.join(outDir, providedFilename),
          path.join(outDir, base, providedFilename),
        ];
      } else {
        // Provided filename without extension — treat like a base name
        const gen = slugifyFilename(providedFilename);
        candidatePaths = [
          path.join(outDir, `${gen}.md`),
          path.join(outDir, gen, `${gen}.md`),
          path.join(outDir, `${gen}.csv`),
        ];
      }
    } else {
      if (target?.title === 'filename') {
        // targetItem.name for this mode is forced to match a local filename (including extension).
        // Avoid re-slugifying and accidentally mangling the extension into the basename.
        const ext = path.extname(targetItem.name || '').toLowerCase();
        const base = ext ? path.basename(targetItem.name, ext) : targetItem.name;
        slugName = base || slugifyFilename(targetItem.id || pageId);
      } else {
        slugName = slugifyFilename(targetItem.name || targetItem.id || pageId);
      }
      candidatePaths = [
        path.join(outDir, `${slugName}.md`),
        path.join(outDir, slugName, `${slugName}.md`),
        path.join(outDir, `${slugName}.csv`),
      ];
    }

    resolvedCandidate = null;
    for (const candidate of candidatePaths) {
      try {
        await fs.stat(candidate);
        const rel = path.relative(process.cwd(), candidate);
        const record = (useLedger && ledger.byNotionId && ledger.byNotionId[pageId] && ledger.byNotionId[pageId].outputs[rel]) || null;
        resolvedCandidate = { candidate, rel, record };
        break;
      } catch {
        continue;
      }
    }

    
    if (target.sync === 'push-only') {
      if (!resolvedCandidate) {
        failedTargets.push({ target, error: `No local file found to upload for ${identifier}` });
        continue;
      }

      let currentLocalHash;
      try {
        currentLocalHash = await calculateFileHash(resolvedCandidate.candidate);
      } catch (err) {
        failedTargets.push({ target, error: `Could not hash ${path.basename(resolvedCandidate.candidate)}: ${err.message}` });
        continue;
      }

      if (resolvedCandidate.record && currentLocalHash === resolvedCandidate.record.last_synced_local_hash) {
        prompts.log.info(`[Up to date] ${path.basename(resolvedCandidate.candidate)} (skipped)`);
        completedTargets.push({ target, item: targetItem, skipped: true });
        continue;
      }

      spin.stop('');
      prompts.log.info(`[Uploading] Syncing local edits back to Notion for ${identifier}...`);
      spin.start('...');

      try {
          const appended = await pushLocalFileToNotion({
              notion,
              pageId,
              targetItem,
              target,
              localOutputPath: resolvedCandidate.candidate,
              currentLocalHash,
              ledger,
              saveStateLedgerFn,
            });
        if (appended === null) {
          // Safety bypass or early abort occurred inside pushLocalFileToNotion.
          prompts.log.warn(`[SAFETY] Push aborted for ${identifier}. Skipping target.`);
          completedTargets.push({ target, item: targetItem, skipped: true, reason: 'safety-bypass' });
          continue;
        }
        prompts.log.info(`[Uploaded] Successfully synced ${appended} block(s) to Notion`);
        completedTargets.push({ target, item: targetItem, pushed: true });
        continue;
      } catch (err) {
        spin.stop('');
        prompts.log.warn(`[Upload Failed] Could not sync local edits: ${err.message}`);
        spin.start('Continuing...');
        failedTargets.push({ target, error: err.message });
        continue;
      }
    }

    // Check ledger for an up-to-date entry and skip if valid.
    let skipped = false;
    let dependencyMismatch = false;
    for (const candidate of candidatePaths) {
      const rel = path.relative(process.cwd(), candidate);
      if (!useLedger) continue;
      // Find record via byPath or byNotionId
      let record = null;
      let nid = null;
      if (ledger.byPath && ledger.byPath[rel]) {
        nid = ledger.byPath[rel];
        record = nid && ledger.byNotionId && ledger.byNotionId[nid] ? ledger.byNotionId[nid].outputs[rel] : null;
      } else if (ledger.byNotionId && ledger.byNotionId[pageId]) {
        nid = pageId;
        record = ledger.byNotionId[pageId].outputs[rel] || null;
      }
      if (!record) continue;
      // Ensure file physically exists
      try {
        await fs.stat(candidate);
      } catch {
        // Missing file — treat as invalid cache and force download
        break;
      }
      // Calculate local hash and compare
      try {
        const localHash = await calculateFileHash(candidate);
        if (localHash === record.last_synced_local_hash && String(targetItem.remoteMtime) === String(record.last_synced_remote_mtime)) {
          if (Array.isArray(record.dependencies) && record.dependencies.length > 0) {
            const mismatch = await dependenciesChanged(notion, record.dependencies);
            if (mismatch) {
              dependencyMismatch = true;
              continue;
            }
          }
          prompts.log.info(`[Skipped] ${path.basename(candidate)} (Up to date)`);
          completedTargets.push({ target, item: targetItem, skipped: true });
          skipped = true;
          break;
        }
      } catch (err) {
        // Hash failed — force download
        break;
      }
    }
    if (skipped) continue;

    // Two-way sync detection: check if local edits need to be pushed to Notion
    let pushedTwoWay = false;
    if (target.sync === 'two-way') {
      // Initialize safe defaults so brand-new/untracked targets are evaluated
      let localOutputPath = null;
      let ledgerRecord = { last_synced_local_hash: '', last_synced_remote_mtime: '' };

      // Look up historical records if they exist in the ledger
      if (useLedger && ledger.byNotionId?.[pageId]?.outputs) {
        for (const [outputPath, record] of Object.entries(ledger.byNotionId[pageId].outputs)) {
          localOutputPath = path.resolve(outputPath);
          ledgerRecord = record;
          break;
        }
      }

      // Fallback: If no history exists, dynamically infer the path from target criteria
      if (!localOutputPath) {
        const targetFilename = target.filename || `${slugifyFilename(targetItem.name || pageId)}.md`;
        localOutputPath = path.resolve(target.outDir || process.cwd(), targetFilename);
      }

      if (localOutputPath && ledgerRecord) {
        try {
          // Check if the local file exists
          await fs.stat(localOutputPath);
          const currentLocalHash = await calculateFileHash(localOutputPath);

          const localHasChanged = currentLocalHash !== ledgerRecord.last_synced_local_hash;
          const remoteHasChanged = dependencyMismatch || String(targetItem.remoteMtime) !== String(ledgerRecord.last_synced_remote_mtime);
          const conflictDetected = localHasChanged && remoteHasChanged;

          if ((localHasChanged && !remoteHasChanged) || (localHasChanged && target.conflict === 'local-wins')) {
            // FORCE AN UPLOAD IMMEDIATELY
            spin.stop('');
            prompts.log.info(`[Force Push] Override token found or local edits updated. Pushing back to Notion...`);
            spin.start('...');

            try {
              const appended = await pushLocalFileToNotion({
                notion,
                pageId,
                targetItem,
                target,
                localOutputPath,
                currentLocalHash,
                ledger,
                saveStateLedgerFn,
              });

                    if (appended === null) {
                      prompts.log.warn(`[SAFETY] Push aborted for ${identifier}. Skipping target.`);
                      completedTargets.push({ target, item: targetItem, skipped: true, reason: 'safety-bypass' });
                      continue;
                    } else {
                      prompts.log.info(`[Uploaded] Successfully synced ${appended} block(s) to Notion for bidirectional target "${identifier}"`);
                      pushedTwoWay = true;
                      completedTargets.push({ target, item: targetItem, pushed: true });
                    }
            } catch (err) {
              spin.stop('');
              prompts.log.warn(`[Push Failed] Could not sync local edits: ${err.message}`);
              spin.start('Continuing...');
            }
          } else if (conflictDetected) {
            const conflictPolicy = target.conflict === 'local-wins' ? 'local-wins' : 'notion-wins';
            if (conflictPolicy === 'local-wins') {
              spin.stop('');
              prompts.log.warn(`[Conflict] Local and Notion both changed for ${identifier}; local-wins will overwrite the cloud copy.`);
              spin.start('...');

              try {
                const appended = await pushLocalFileToNotion({
                  notion,
                  pageId,
                  targetItem,
                  localOutputPath,
                  currentLocalHash,
                  ledger,
                  saveStateLedgerFn,
                });
                if (appended === null) {
                  prompts.log.warn(`[SAFETY] Push aborted for ${identifier}. Skipping target.`);
                  completedTargets.push({ target, item: targetItem, skipped: true, reason: 'safety-bypass' });
                  continue;
                } else {
                  prompts.log.info(`[Pushed] Successfully resolved conflict by overwriting Notion for ${identifier}`);
                  pushedTwoWay = true;
                  completedTargets.push({ target, item: targetItem, pushed: true });
                }
              } catch (err) {
                spin.stop('');
                prompts.log.warn(`[Push Failed] Could not resolve conflict: ${err.message}`);
                spin.start('Continuing...');
              }
            } else {
              prompts.log.warn(`[Conflict] Local and Notion both changed for ${identifier}; pulling Notion version to preserve cloud edits.`);
            }
          }
        } catch (err) {
          // Local file doesn't exist or other error — skip two-way, continue to download
        }
      }
    }

    if (pushedTwoWay) continue;

    // Download the target
      try {
      const format = target.format || 'markdown-tree';
      const downloadOpts = { format, debug: args.debug, frontmatter: target.frontmatter !== undefined ? target.frontmatter : false };

      const stats = await downloadFn(
        [targetItem],
        outDir,
        notion,
        {
          onStatus: (msg) => spin.message(`${prefix} ${msg}`),
          onLog: (msg) => {
            spin.stop(msg);
            spin.start('...');
          },
          onError: (msg) => {
            spin.stop('');
            prompts.log.warn(msg);
            spin.start('Continuing...');
          },
        },
        downloadOpts
      );

      if (Array.isArray(stats?.errors) && stats.errors.length > 0) {
        const details = stats.errors.map((entry) => entry?.error || String(entry)).join('; ');
        failedTargets.push({ target, error: `Partial download failed: ${details}` });
        continue;
      }

      // After successful download, find the main output file and update ledger
      const match = (stats && Array.isArray(stats.writtenFiles)) ? stats.writtenFiles.find((f) => {
        const b = path.basename(f);
        if (providedFilename && path.extname(providedFilename)) {
          return b === providedFilename;
        }
        return b === `${slugName}.md` || b === `${slugName}.csv`;
      }) : null;

      if (match && useLedger) {
        let fileHash = null;
        try {
          fileHash = await calculateFileHash(match);
          const relKey = path.relative(process.cwd(), match);
          // Ensure notion entry exists
          ledger.byNotionId = ledger.byNotionId || {};
          ledger.byPath = ledger.byPath || {};
          ledger.byNotionId[pageId] = ledger.byNotionId[pageId] || { notion_id: pageId, outputs: {} };
          ledger.byNotionId[pageId].outputs[relKey] = {
            last_synced_remote_mtime: targetItem.remoteMtime || null,
            last_synced_local_hash: fileHash,
            hasSyncedBlocks: stats.foundSyncedBlocks || false,
            dependencies: Array.isArray(stats.dependencies) ? stats.dependencies : [],
          };
          ledger.byPath[relKey] = pageId;
        } catch (err) {
          // Non-fatal: continue without ledger update
        }
      }

      completedTargets.push({ target, item: targetItem });
      spin.start(`${prefix} Done: ${identifier}`);
    } catch (err) {
      failedTargets.push({ target, error: err.message });
    }
  }

  // Persist ledger back to disk (unless bypassed)
  if (useLedger) {
    try {
      await saveStateLedgerFn(ledger);
    } catch (err) {
      prompts.log.warn(`Could not save state ledger: ${err.message}`);
    }
  }

  spin.stop('Batch sync complete.');

  // Summary
  prompts.log.success(`Completed: ${completedTargets.length}/${targets.length} target${targets.length === 1 ? '' : 's'}`);
  if (failedTargets.length > 0) {
    prompts.log.warn(`Failed: ${failedTargets.length} target${failedTargets.length === 1 ? '' : 's'}`);
    for (const { target, error } of failedTargets) {
      const id = target.source || target.name || 'unknown target';
      prompts.log.warn(`  - ${id}: ${error}`);
    }
  }

  return { completedTargets, failedTargets };
}

// new: status reporter for manifest targets
export async function executeStatus(manifest, token, args = {}, overrides = {}) {
  const prompts = overrides.prompts || p;
  const fs = overrides.fs || (await import('fs/promises'));

  // Manifest integrity guardrail for status: run basic duplicate checks
  // before making network calls to Notion.
  try {
    const targets = (manifest && Array.isArray(manifest.targets)) ? manifest.targets : [];
    // Normalize `path` into `outDir`/`filename` for parity with executeSyncMode
    for (const t of targets) normalizeTarget(t);
    const seenLocalPaths = new Set();
    const seenNotionIds = new Map();
    for (const target of targets) {
      if (!target || target.disabled) continue;
      let pageId = null;
      try {
        pageId = extractNotionId(target.source);
      } catch (err) {
        continue;
      }

      const targetFilename = target.filename || `${slugifyFilename(target.name || pageId)}.md`;
      const rawOutDir = target.outDir || process.cwd();
      const expandedOutDir = rawOutDir && rawOutDir.startsWith('~') ? path.join(process.env.HOME || os.homedir(), rawOutDir.slice(1)) : rawOutDir;
      const absoluteLocalPath = path.resolve(expandedOutDir || process.cwd(), targetFilename);

      if (seenLocalPaths.has(absoluteLocalPath)) {
        const origins = await getManifestEntriesForPath(absoluteLocalPath);
        let detailMsg = '\n';
        if (origins.length > 0) {
          detailMsg += 'Conflicting definitions found:';
          for (const o of origins) {
            const idxs = o.matches.map((m) => m.index).join(', ');
            detailMsg += `\n - ${o.manifestPath}: targets[${idxs}]`;
            for (const m of o.matches) {
              detailMsg += `\n    - index ${m.index}: name=${m.name}, filename=${m.filename}, outDir=${m.outDir}, source=${m.source}`;
            }
          }
        } else {
          detailMsg += 'No manifest files located to show origins.';
        }

        prompts.log.error(`[CONFIG ERROR] Manifest target collision detected. Multiple targets are mapped to write to the same local file destination: "${absoluteLocalPath}". Status aborted to protect local assets.${detailMsg}`);
        return { results: [] };
      }
      seenLocalPaths.add(absoluteLocalPath);

      if (pageId && seenNotionIds.has(pageId) && seenNotionIds.get(pageId) !== targetFilename) {
        const priorFilename = seenNotionIds.get(pageId);
        let detailMsg = `\n - existing mapping: ${priorFilename}\n - current mapping: ${targetFilename}`;
        try {
          const candidates = [path.resolve(process.cwd(), 'notiondrive.config.json'), path.join(os.homedir(), '.notiondrive', 'config.json')];
          const found = [];
          for (const cpath of candidates) {
            try {
              const raw = await fs.readFile(cpath, 'utf-8');
              const parsed = JSON.parse(raw);
              const targets = parsed && Array.isArray(parsed.targets) ? parsed.targets : [];
              for (let i = 0; i < targets.length; i++) {
                const t = targets[i];
                if (!t) continue;
                try {
                  const pid = extractNotionId(t.source || '');
                  if (String(pid) === String(pageId)) {
                    let fn;
                    if (typeof t.path === 'string' && String(t.path).trim()) {
                      const pth = String(t.path).trim();
                      const ext = path.extname(pth);
                      fn = ext ? path.basename(pth) : `${slugifyFilename(t.name || pid)}.md`;
                    } else {
                      fn = t.filename || `${slugifyFilename(t.name || pid)}.md`;
                    }
                    found.push({ manifestPath: cpath, index: i, filename: fn, name: t.name || '<no-name>' });
                  }
                } catch (err) {}
              }
            } catch (err) {}
          }
          if (found.length > 0) {
            detailMsg += '\nConflicting definitions found in manifests:';
            for (const f of found) {
              detailMsg += `\n - ${f.manifestPath}: targets[${f.index}] -> filename=${f.filename} (name=${f.name})`;
            }
          }
        } catch (err) {
          // ignore
        }

        prompts.log.error(`[CONFIG ERROR] Resource mapping collision detected. Notion page ID "${pageId}" is mapped to two separate local file outputs ("${seenNotionIds.get(pageId)}" and "${targetFilename}"). Status aborted to prevent cloud asset clobbering.${detailMsg}`);
        return { results: [] };
      }
      if (pageId) seenNotionIds.set(pageId, targetFilename);
    }
  } catch (err) {
    // Continue on unexpected errors during preflight
  }

  if (!manifest || !Array.isArray(manifest.targets) || manifest.targets.length === 0) {
    prompts.log.error('No sync targets found in manifest.');
    return { results: [] };
  }
  if (!token) {
    prompts.log.error('No Notion token found. Provide NOTION_TOKEN or save a token in ~/.notiondrive/config.json.');
    return { results: [] };
  }

  const NotionClass = overrides.notionClass || NotionClient;
  const notion = overrides.notion || new NotionClass(token);

  try {
    if (!overrides.notion) await notion.validateToken();
  } catch (err) {
    prompts.log.error(`Could not connect to Notion: ${err.message || err}`);
    return { results: [] };
  }

  const loadStateLedgerFn = overrides.loadStateLedger || loadStateLedger;
  let ledger;
  try {
    ledger = await loadStateLedgerFn();
  } catch {
    ledger = { byNotionId: {}, byPath: {} };
  }

  const results = [];
  const counts = { upToDate: 0, needsPull: 0, needsPush: 0, conflict: 0, remoteOnly: 0, localUntracked: 0, disabled: 0, failed: 0 };

  // Apply optional filters (name/group) to narrow targets before network calls
  let targets = manifest.targets || [];
  const statusFilter = args?.statusFilter || args?.syncFilter || null;
  const groupFilter = args?.groupFilter || null;

  if (statusFilter || groupFilter) {
    let filtered = targets;
    let filterPageId = null;
    let filterAbsoluteLocalPath = null;
    let isFilterDirectory = false;

    if (statusFilter) {
      filterPageId = extractNotionId(statusFilter);
      filterAbsoluteLocalPath = path.resolve(process.cwd(), statusFilter);
      try {
        const stats = await fs.stat(filterAbsoluteLocalPath);
        if (stats.isDirectory()) isFilterDirectory = true;
        filterAbsoluteLocalPath = await fs.realpath(filterAbsoluteLocalPath);
      } catch {
        isFilterDirectory = false;
      }
    }

    // Async-aware filtering so directory comparisons can use realpath
    filtered = await (async () => {
      const checks = await Promise.all(filtered.map(async (t) => {
        if (!t) return false;
        if (groupFilter && t.group !== groupFilter) return false;
        if (!statusFilter) return true;

        const targetPageId = extractNotionId(t.source || '');
        const targetFilename = t.filename || `${slugifyFilename(t.name || targetPageId)}.md`;

        // Resolve and expand target directory
        const rawOutDir = t.outDir || process.cwd();
        const expandedOutDir = rawOutDir && rawOutDir.startsWith('~')
          ? path.join(process.env.HOME || os.homedir(), rawOutDir.slice(1))
          : rawOutDir;

        let targetDirAbsolute = path.resolve(expandedOutDir || process.cwd());
        // Enforce realpath symmetry to prevent macOS path-matching failures:
        try {
          if (isFilterDirectory) {
            targetDirAbsolute = await fs.realpath(targetDirAbsolute);
          }
        } catch {}

        if (isFilterDirectory) {
          try {
            const rel = path.relative(filterAbsoluteLocalPath, targetDirAbsolute);
            if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
              return true;
            }
          } catch {}
          return t.group === statusFilter;
        }

        const targetAbsoluteLocalPath = path.resolve(targetDirAbsolute, targetFilename);

        const filenameMatches = typeof t.filename === 'string' && (t.filename === statusFilter || t.filename.startsWith(statusFilter));
        const nameMatches = typeof t.name === 'string' && (t.name === statusFilter || String(t.name).toLowerCase().startsWith(String(statusFilter).toLowerCase()));
        let pathPrefixMatches = false;
        try {
          if (typeof filterAbsoluteLocalPath === 'string' && typeof targetAbsoluteLocalPath === 'string') {
            pathPrefixMatches = targetAbsoluteLocalPath === filterAbsoluteLocalPath || targetAbsoluteLocalPath.startsWith(filterAbsoluteLocalPath);
          }
        } catch {}

        return (
          t.source === statusFilter ||
          targetPageId === filterPageId ||
          pathPrefixMatches ||
          filenameMatches ||
          t.group === statusFilter ||
          nameMatches
        );
      }));
      return filtered.filter((_, i) => checks[i]);
    })();

    if (!filtered || filtered.length === 0) {
      const filterText = statusFilter || groupFilter || '';
      prompts.log.warn(`No sync targets found matching filter: "${filterText}".`);
      return { results: [], counts };
    }

    targets = filtered;
  }

  for (const target of targets) {
    if (!target) continue;
    if (target.disabled) {
      counts.disabled++;
      results.push({ name: target.name || target.source || '<no-name>', status: 'disabled' });
      continue;
    }

    const source = target.source || '';
    const pageId = extractNotionId(source);
    if (!pageId) {
      counts.failed++;
      results.push({ name: source, status: 'invalid-source' });
      continue;
    }

    // fetch remote info (page or database)
    let name = pageId;
    let remoteType = 'page';
    let remoteMtime = null;
    try {
      const page = await notion.getPage(pageId);
      name = extractTitle(page) || name;
      remoteType = 'page';
      remoteMtime = page?.last_edited_time || null;
    } catch {
      try {
        const db = await notion.getDatabase(pageId);
        name = extractDatabaseTitle(db) || name;
        remoteType = 'database';
        remoteMtime = db?.last_edited_time || null;
      } catch (err) {
        counts.failed++;
        results.push({ name: source, status: 'remote-fetch-failed', error: err.message || String(err) });
        continue;
      }
    }

    // resolve candidate file paths (same logic as executeSyncMode)
    const rawOutDir = target.outDir || process.cwd();
    const expandedOutDir = rawOutDir.startsWith('~') ? path.join(process.env.HOME || os.homedir(), rawOutDir.slice(1)) : rawOutDir;
    const outDir = path.resolve(expandedOutDir);

    const providedFilename = typeof target.filename === 'string' && target.filename.trim() ? target.filename.trim() : null;
    let slugName;
    let candidatePaths = [];
    if (providedFilename) {
      const ext = path.extname(providedFilename).toLowerCase();
      const base = ext ? path.basename(providedFilename, ext) : providedFilename;
      slugName = base;
      if (ext) {
        candidatePaths = [path.join(outDir, providedFilename), path.join(outDir, base, providedFilename)];
      } else {
        const gen = slugifyFilename(providedFilename);
        candidatePaths = [path.join(outDir, `${gen}.md`), path.join(outDir, gen, `${gen}.md`), path.join(outDir, `${gen}.csv`)];
      }
    } else {
      slugName = slugifyFilename(name || pageId);
      candidatePaths = [path.join(outDir, `${slugName}.md`), path.join(outDir, slugName, `${slugName}.md`), path.join(outDir, `${slugName}.csv`)];
    }

    // detect local file
    let localPath = null;
    let localExists = false;
    for (const c of candidatePaths) {
      try {
        await fs.stat(c);
        localExists = true;
        localPath = c;
        break;
      } catch {
        // not found
      }
    }

    // find ledger record
    let ledgerRel = null;
    let ledgerRec = null;
    if (ledger) {
      for (const c of candidatePaths) {
        const rel = path.relative(process.cwd(), c);
        if (ledger.byPath && ledger.byPath[rel]) {
          const nid = ledger.byPath[rel];
          ledgerRec = ledger.byNotionId && ledger.byNotionId[nid] ? ledger.byNotionId[nid].outputs[rel] : null;
          if (ledgerRec) { ledgerRel = rel; break; }
        }
      }
      if (!ledgerRec && ledger.byNotionId && ledger.byNotionId[pageId]) {
        for (const outP of Object.keys(ledger.byNotionId[pageId].outputs || {})) {
          ledgerRec = ledger.byNotionId[pageId].outputs[outP];
          ledgerRel = outP;
          break;
        }
      }
    }

    // compute local hash if file exists
    let localHash = null;
    let localMtime = null;
    if (localExists) {
      try {
        localHash = await calculateFileHash(localPath);
        try {
          const st = await fs.stat(localPath);
          localMtime = st.mtime ? new Date(st.mtime).toISOString() : null;
        } catch {
          localMtime = null;
        }
      } catch { /* ignore */ }
    }

    // determine status
    let status = 'unknown';
    let recommendation = '';

    if (!ledgerRec) {
      if (localExists) {
        status = 'local-untracked';
        counts.localUntracked++;
        recommendation = 'Consider adding this path to your manifest or push upstream';
      } else {
        status = 'remote-only';
        counts.remoteOnly++;
        recommendation = 'Run sync to download';
      }
    } else {
      const remoteChanged = String(remoteMtime) !== String(ledgerRec.last_synced_remote_mtime);
      const localChanged = localExists && String(localHash) !== String(ledgerRec.last_synced_local_hash);
      if (localChanged && remoteChanged) {
        status = 'conflict';
        counts.conflict++;
        recommendation = 'Resolve conflict (check local file and choose conflict policy)';
      } else if (localChanged) {
        status = 'local-changed';
        counts.needsPush++;
        recommendation = 'Local has changed (eligible for push)';
      } else if (remoteChanged) {
        status = 'remote-changed';
        counts.needsPull++;
        recommendation = 'Remote has changed (download/pull recommended)';
      } else {
        status = 'up-to-date';
        counts.upToDate++;
        recommendation = 'None';
      }
    }

    results.push({
      name,
      id: pageId,
      type: remoteType,
      outDir,
      localPath,
      ledgerRel,
      status,
      recommendation,
      localHash,
      localMtime,
      remoteMtime,
    });
  }
  // Apply post-filters (status, since, exclude-disabled) before display
  let displayed = results;

  if (args?.excludeDisabled) {
    displayed = displayed.filter((r) => r.status !== 'disabled');
  }

  if (args?.onlyStatus) {
    const wanted = new Set(String(args.onlyStatus).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
    displayed = displayed.filter((r) => wanted.has(String(r.status || '').toLowerCase()));
  }

  if (typeof args?.sinceDays === 'number' && !isNaN(args.sinceDays)) {
    const sinceMs = Number(args.sinceDays) * 24 * 60 * 60 * 1000;
    const now = Date.now();
    displayed = displayed.filter((r) => {
      const t = r.remoteMtime ? Date.parse(r.remoteMtime) : (r.localMtime ? Date.parse(r.localMtime) : null);
      if (!t || isNaN(t)) return false;
      return (now - t) <= sinceMs;
    });
  }

  // Compute display counts from filtered results
  const displayCounts = displayed.reduce((acc, r) => {
    const key = r.status || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  // Output
  console.log('\nNotion Drive sync status\n');
  if (args?.jsonOutput) {
    console.log(JSON.stringify({ results: displayed, counts: displayCounts }, null, 2));
    return { results: displayed, counts: displayCounts };
  }

  try {
    console.table(displayed.map(r => ({ Name: r.name, Id: r.id, Type: r.type, Status: r.status, Local: r.localPath || '', Ledger: r.ledgerRel || '', Action: r.recommendation })));
  } catch {
    for (const r of displayed) {
      console.log(`${r.name} (${r.id}) — ${r.status} — ${r.recommendation}`);
    }
  }

  console.log('\nSummary:', displayCounts);
  return { results: displayed, counts: displayCounts };
}

/**
 * Build a map of file paths to their associated target metadata (pageId, target config, etc).
 * Returns { [filePath]: { pageId, target, targetItem, localOutputPath, ... } }
 */
function buildFileTargetMap(manifest, ledger) {
  const fileMap = {};
  const targets = manifest.targets || [];
  
  for (const target of targets) {
    if (!target) continue;
    normalizeTarget(target); // Fix watch capability for path-only targets
    // Only watch files for two-way or push-only targets
    if (target.disabled === true) continue;
    // Watch targets that can push upstream
    if (!target.sync || (target.sync !== 'two-way' && target.sync !== 'push-only')) {
      continue;
    }
    
    if (!target.source) continue;
    const pageId = extractNotionId(target.source);
    if (!pageId) continue;
    
    // Find tracked files in ledger for this pageId
    const ledgerEntry = ledger.byNotionId?.[pageId];
    if (!ledgerEntry || !ledgerEntry.outputs) continue;
    
    for (const [outputPath, record] of Object.entries(ledgerEntry.outputs)) {
      const resolvedPath = path.resolve(outputPath);
      fileMap[resolvedPath] = {
        pageId,
        target,
        outputPath: resolvedPath,
        ledgerRecord: record,
      };
    }
  }
  
  return fileMap;
}

/**
 * Push a single changed file to Notion (isolated, targeted push).
 * Returns true if push succeeded, false if safety-bypassed or failed.
 */
async function pushSingleFileToNotionWatched({ notion, pageId, filePath, ledger, saveStateLedgerFn, prompts = p, target }) {
  try {
    const localContent = await fs.readFile(filePath, 'utf-8');
    const currentHash = await calculateFileHash(filePath);

    const remoteBlocks = await preflightRemoteWrite(notion, pageId, () => {
      prompts.log.warn(`[SAFETY] Aborting push for ${path.basename(filePath)}. Remote Notion canvas contains child_database or synced_block; run with --force to override.`);
    });
    if (!remoteBlocks) return false;

    const uploadContent = await prepareUploadContent({
      notion, pageId, target, localContent, localOutputPath: filePath,
    });
    const blocks = markdownToNotionBlocks(uploadContent, filePath);
    await notion.clearPageContent(pageId);
    await notion.appendPageContent(pageId, blocks);
    const refreshedPage = await notion.getPage(pageId);
    const newRemoteMtime = refreshedPage?.last_edited_time || null;
    const relKey = path.relative(process.cwd(), filePath);

    await saveLedgerBaseline(ledger, pageId, relKey, {
      last_synced_remote_mtime: newRemoteMtime,
      last_synced_local_hash: currentHash,
    }, saveStateLedgerFn);
    return true;
  } catch (err) {
    prompts.log.error(`[Watcher] Push failed for ${path.basename(filePath)}: ${err.message}`);
    return false;
  }
}

/**
 * Start watch mode: run baseline sync, then monitor files for changes.
 * Implements isolated, real-time pushes on file modifications.
 */
export async function startSyncWatchMode(manifest, token, args, overrides = {}) {
  const prompts = overrides.prompts || p;
  
  // Run baseline sync first to align local and remote
  prompts.log.info('[Watcher] Running baseline sync...');
  const result = await executeSyncMode(manifest, token, args, overrides);
  if (result.failedTargets?.length) {
    prompts.log.warn('[Watcher] Baseline sync had failures; watch mode will not start.');
    return result;
  }
  prompts.log.success('[Watcher] Baseline sync complete.');
  
  const NotionClass = overrides.notionClass || NotionClient;
  const loadStateLedgerFn = overrides.loadStateLedger || loadStateLedger;
  const saveStateLedgerFn = overrides.saveStateLedger || saveStateLedger;
  const notion = overrides.notion || new NotionClass(token);
  const watchFn = overrides.watch || watch;
  
  // Load ledger to build file-to-target map
  let ledger;
  try {
    ledger = await loadStateLedgerFn();
  } catch {
    ledger = { byNotionId: {}, byPath: {} };
  }
  const fileTargetMap = buildFileTargetMap(manifest, ledger);
  
  if (Object.keys(fileTargetMap).length === 0) {
    prompts.log.warn('[Watcher] No tracked files found. Exiting watch mode.');
    return;
  }
  
  prompts.log.success(`[Watcher] Monitoring ${Object.keys(fileTargetMap).length} file(s) for changes...`);
  prompts.log.info('[Watcher] Press Ctrl+C to exit.');
  
  // Track active watchers so we can clean up on shutdown
  const activeWatchers = [];
  
  // Build a set of unique directories to watch
  const dirsToWatch = new Set();
  for (const filePath of Object.keys(fileTargetMap)) {
    const dir = path.dirname(filePath);
    dirsToWatch.add(dir);
  }
  
  // Setup file watchers on each directory
  for (const dir of dirsToWatch) {
    try {
      const watcher = watchFn(dir, async (eventType, filename) => {
        if (!filename) return;
        
        const changedPath = path.resolve(dir, filename);
        const metadata = fileTargetMap[changedPath];
        
        if (!metadata) return; // Not a tracked file
        if (eventType !== 'change') return; // Only handle 'change' events
        
        // Add debounce: wait a bit before processing to handle multiple events
        clearTimeout(metadata.debounceTimer);
        metadata.debounceTimer = setTimeout(async () => {
          try {
            // Reload ledger to get latest state
            try {
              ledger = await loadStateLedgerFn();
            } catch {
              ledger = { byNotionId: {}, byPath: {} };
            }
            const record = ledger.byNotionId?.[metadata.pageId]?.outputs?.[path.relative(process.cwd(), changedPath)];
            
            if (!record) return;
            
            const currentHash = await calculateFileHash(changedPath);
            if (currentHash === record.last_synced_local_hash) {
              return; // No change in hash, skip
            }
            
            // File changed, push it
            const filename = path.basename(changedPath);
            prompts.log.info(`[Watcher] Local change detected in ${filename}.`);
            
            const success = await pushSingleFileToNotionWatched({
              notion,
              pageId: metadata.pageId,
              filePath: changedPath,
              ledger,
              saveStateLedgerFn,
              prompts,
              target: metadata.target,
            });
            
            if (success) {
              const timestamp = new Date().toLocaleTimeString();
              prompts.log.success(`[Watcher] ${timestamp} - Pushed upstream successfully.`);
            }
          } catch (err) {
            prompts.log.error(`[Watcher] Error processing change: ${err.message}`);
          }
        }, 500); // 500ms debounce
      });
      
      activeWatchers.push(watcher);
    } catch (err) {
      prompts.log.warn(`[Watcher] Could not watch directory ${dir}: ${err.message}`);
    }
  }
  
  // Handle clean shutdown on Ctrl+C
  process.on('SIGINT', async () => {
    prompts.log.info('\n[Watcher] Shutting down...');
    
    // Close all watchers
    for (const watcher of activeWatchers) {
      try {
        watcher.close();
      } catch {
        // Already closed
      }
    }
    
    // Flush ledger to disk one last time
    try {
      ledger = await loadStateLedgerFn();
      await saveStateLedgerFn(ledger);
      prompts.log.success('[Watcher] Ledger saved. Exiting.');
    } catch (err) {
      prompts.log.warn(`[Watcher] Could not save ledger: ${err.message}`);
    }
    
    process.exit(0);
  });
}
