import path from 'node:path';
import { realpath, lstat, readlink } from 'node:fs/promises';

function richText(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return null;
  return value.map((part) => part?.plain_text ?? part?.text?.content ?? '').join('');
}

function propertyValue(property) {
  if (!property || typeof property !== 'object') return { error: 'missing or unsupported property' };
  if (property.type === 'title' || property.type === 'rich_text') {
    const value = richText(property[property.type]);
    return value === null ? { error: 'unsupported text property value' } : { value };
  }
  if (property.type === 'select') {
    const selection = property.select;
    if (selection === null) return { value: '' };
    if (!selection || typeof selection !== 'object' || typeof selection.name !== 'string') return { error: 'unsupported or ambiguous select property value' };
    return { value: selection.name };
  }
  if (property.type === 'files') return { error: 'file properties cannot identify a repository path' };
  return { error: `unsupported property type: ${property.type || 'unknown'}` };
}

function cleanFilename(value) {
  const normalized = value.normalize('NFC').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1').replace(/\*([^*]+)\*/g, '$1').replace(/_([^_]+)_/g, '$1').trim();
  if (!normalized || normalized === '.' || normalized === '..' || /[\\/\0]/.test(normalized) || /^[a-z][a-z0-9+.-]*:/i.test(normalized)) return null;
  return normalized;
}

function canonicalizeNotionPageId(value) {
  if (typeof value !== 'string' || !/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(value)) return null;
  return value.replace(/-/g, '').toLowerCase();
}

async function checkPath(root, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim() || path.isAbsolute(relativePath) || relativePath.includes('\\') || relativePath.includes('\0')) return 'destination is not a valid relative path';
  const normalized = path.posix.normalize(relativePath);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized !== relativePath || relativePath.split('/').some((part) => !part || part === '.' || part === '..')) return 'destination contains traversal or ambiguous path components';
  const absoluteRoot = path.resolve(root);
  const components = normalized.split('/');
  let actualRoot;
  try { actualRoot = await realpath(absoluteRoot); } catch { return 'repository root does not exist'; }
  let current = absoluteRoot;
  for (const [index, segment] of components.entries()) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (index < components.length - 1 && !info.isSymbolicLink() && !info.isDirectory()) return 'destination has a non-directory parent component';
      if (info.isSymbolicLink()) {
        const target = await readlink(current);
        const targetPath = path.resolve(path.dirname(current), target);
        if (targetPath !== actualRoot && !targetPath.startsWith(`${actualRoot}${path.sep}`)) return 'destination traverses a symlink outside the repository root';
        let resolved;
        try { resolved = await realpath(current); } catch (resolveError) {
          if (resolveError.code === 'ENOENT') return 'destination traverses an unresolved symlink';
          if (resolveError.code === 'ENOTDIR') return 'destination has a non-directory parent component';
          throw resolveError;
        }
        if (resolved !== actualRoot && !resolved.startsWith(`${actualRoot}${path.sep}`)) return 'destination traverses a symlink outside the repository root';
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        let parent = path.dirname(current);
        while (parent !== absoluteRoot && parent.startsWith(`${absoluteRoot}${path.sep}`)) {
          try {
            const parentInfo = await lstat(parent);
            if (parentInfo.isSymbolicLink()) return 'destination traverses an unresolved symlink';
            parent = path.dirname(parent);
          } catch (parentError) {
            if (parentError.code !== 'ENOENT') return `cannot validate destination: ${parentError.message}`;
            parent = path.dirname(parent);
          }
        }
      }
      if (error.code === 'ENOTDIR') return 'destination has a non-directory parent component';
      if (error.code !== 'ENOENT') return `cannot validate destination: ${error.message}`;
    }
  }
  const resolved = path.resolve(absoluteRoot, ...normalized.split('/'));
  if (resolved !== absoluteRoot && !resolved.startsWith(`${absoluteRoot}${path.sep}`)) return 'destination escapes repository root';
  return null;
}

export async function discoverDocuments({ notion, databaseId, dataSourceId, properties = {}, root = process.cwd(), overrides = [] }) {
  if (!notion || (typeof notion.queryDatabase !== 'function' && typeof notion.queryDataSource !== 'function')) throw new Error('A Notion client with database query support is required');
  if ((!databaseId && !dataSourceId) || (databaseId && dataSourceId)) throw new Error('Specify exactly one of databaseId or dataSourceId');
  const query = dataSourceId ? notion.queryDataSource : notion.queryDatabase;
  if (typeof query !== 'function') throw new Error(`Notion client does not support ${dataSourceId ? 'data-source' : 'database'} queries`);
  const names = { filename: properties.filename || 'Name', directory: properties.directory || 'Repository Directory' };
  const pages = await query.call(notion, dataSourceId || databaseId);
  if (!Array.isArray(pages)) throw new Error('Notion query returned an invalid results collection');
  const records = pages.map((page) => ({ page, rawId: page?.id, id: canonicalizeNotionPageId(page?.id), title: '' }));
  const counts = new Map();
  for (const item of records) if (item.id) counts.set(item.id, (counts.get(item.id) || 0) + 1);
  const overrideMap = new Map();
  const overrideErrors = [];
  const duplicateOverrideIds = new Set();
  for (const override of overrides) {
    const id = canonicalizeNotionPageId(override?.pageId);
    if (!id || overrideMap.has(id)) {
      if (id) {
        duplicateOverrideIds.add(id);
        const existing = overrideErrors.find((item) => item.id === id);
        if (existing) existing.reason = 'duplicate override page ID';
        else overrideErrors.push({ id, reason: 'duplicate override page ID' });
      } else overrideErrors.push({ id, reason: 'missing or malformed override page ID' });
      continue;
    }
    overrideMap.set(id, override.path);
  }
  const results = [];
  for (const { page, id } of records) {
    const titleProp = page?.properties?.[names.filename];
    const directoryProp = page?.properties?.[names.directory];
    const titleResult = propertyValue(titleProp);
    const directoryResult = propertyValue(directoryProp);
    const title = titleResult.value ?? '';
    let candidate = null;
    let reason = null;
    if (!id) reason = 'missing or malformed Notion page ID';
    else if (duplicateOverrideIds.has(id)) reason = 'duplicate override page ID';
    else if (counts.get(id) > 1) reason = 'duplicate Notion page identity';
    else if (overrideMap.has(id)) {
      const overridePath = overrideMap.get(id);
      if (typeof overridePath !== 'string' || !overridePath.trim()) reason = 'override destination must be a non-empty string';
      else candidate = overridePath;
    }
    else if (titleResult.error) reason = `filename: ${titleResult.error}`;
    else if (directoryResult.error) reason = `directory: ${directoryResult.error}`;
    else if (!directoryResult.value.trim()) reason = 'missing directory';
    else {
      const filename = cleanFilename(title);
      if (!filename) reason = 'empty or invalid filename';
      else {
        const directory = directoryResult.value.replace(/\\/g, '/').replace(/\/+$/, '');
        candidate = `${directory ? `${directory}/` : ''}${filename}`;
      }
    }
    let source = overrideMap.has(id) ? 'explicit override' : 'derived';
    if (!reason) reason = await checkPath(root, candidate);
    results.push({ pageId: id || null, title, path: reason ? null : candidate, source, status: reason ? 'requires_review' : 'mapped', reason, provenance: { databaseId: databaseId || null, dataSourceId: dataSourceId || null, pageId: id || null, filenameProperty: names.filename, directoryProperty: names.directory, directory: directoryResult.value ?? null, filename: titleResult.value ?? null } });
  }
  for (const error of overrideErrors) results.push({ pageId: error.id || null, title: '', path: null, source: 'explicit override', status: 'requires_review', reason: error.reason, provenance: null });
  const discoveredIds = new Set(records.map((item) => item.id).filter(Boolean));
  for (const [id, overridePath] of overrideMap) {
    if (!discoveredIds.has(id)) {
      results.push({ pageId: id, title: '', path: null, source: 'explicit override', status: 'requires_review', reason: 'override page ID was not found in the discovery results', provenance: null });
    }
  }
  const destinations = new Map();
  for (const result of results) if (result.path) {
    const key = result.path.normalize('NFC').toLocaleLowerCase('en-US');
    if (destinations.has(key)) {
      result.path = null; result.status = 'requires_review'; result.reason = 'duplicate output path';
      const first = destinations.get(key); first.path = null; first.status = 'requires_review'; first.reason = 'duplicate output path';
    } else destinations.set(key, result);
  }
  Object.defineProperty(results, 'source', { value: { type: dataSourceId ? 'data_source' : 'database', id: dataSourceId || databaseId }, enumerable: false });
  Object.defineProperty(results, 'pages', { value: pages, enumerable: false });
  return results;
}
