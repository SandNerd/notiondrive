import * as p from '@clack/prompts';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { NotionClient } from './notion.js';
import { extractTitle, extractDatabaseTitle } from './notion-helpers.js';
import { loadConfig, loadProjectConfig, saveConfig, flattenManifest } from './config.js';
import { getSaveLocationOptions, isWritablePath, safeMerge } from './utils.js';
import { downloadPages } from './download.js';
import { executeSyncMode, startSyncWatchMode, executeStatus } from './sync.js';
import { discoverDocuments } from './discovery.js';
import { realpath } from 'node:fs/promises';

/** Exit cleanly if the user cancels a prompt. */
function exitIfCancelled(value) {
  if (p.isCancel(value)) {
    p.cancel('Cancelled.');
    process.exit(0);
  }
  return value;
}

export async function browseAndSelect(notion, savedConfig, prompts = p) {
  const selectedItemsMap = new Map(); // pageId/databaseId -> { id, name, type }
  let currentFolderId = null; // null means Notion root
  let currentFolderName = 'Notion Root';
  const folderHistoryStack = []; // [{ id, name }]
  let emptyFetchAttempts = 0;
  const MAX_EMPTY_FETCH_ATTEMPTS = 5;

  const spin = prompts.spinner ? prompts.spinner() : { start: () => {}, stop: () => {}, message: () => {} };

  if (prompts.log && prompts.log.info) prompts.log.info('Hint: Enter selects a row. Use rows to toggle items or drill into folders.');

  let selected;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    spin.start(currentFolderId ? `Loading folder: ${currentFolderName}...` : 'Fetching your pages...');

    let items = [];
    try {
      if (currentFolderId === null) {
          const topLevelItems = await notion.getTopLevelPages({
            onProgress: (count) => spin.message(`Scanning... (${count} items found)`),
          });

        items = topLevelItems.map((item) => ({
          id: item.id,
          name: item.title || item.id,
          type: item.type,
          isFolder: item.type === 'database' || Boolean(item.hasChildren),
        }));
      } else {
        try {
          const children = await notion.getBlockChildren(currentFolderId);
          const filtered = children.filter((block) => block.type === 'child_page' || block.type === 'child_database');
          items = filtered.map((block) => {
            const isDatabase = block.type === 'child_database';
            const name = isDatabase
              ? (block.child_database?.title || block.id)
              : (block.child_page?.title || block.id);

            return {
              id: block.id,
              name,
              type: isDatabase ? 'database' : 'page',
              isFolder: isDatabase || Boolean(block.has_children),
            };
          });
        } catch {
          // If this ID is a database, allow drill-down by listing its rows as pages.
          const rows = await notion.queryDatabase(currentFolderId);
          items = rows.map((row) => ({
            id: row.id,
            name: extractTitle(row) || row.id,
            type: 'page',
            isFolder: false,
          }));
        }
      }
    } catch (err) {
      spin.stop('Failed to fetch items.');
      p.log.error(`Error: ${err.message}`);
      throw err;
    }

    spin.stop(currentFolderId
      ? `Found ${items.length} item${items.length === 1 ? '' : 's'} in ${currentFolderName}.`
      : `Found ${items.length} top-level item${items.length === 1 ? '' : 's'}.`);

    if (items.length > 0) emptyFetchAttempts = 0;

    if (currentFolderId === null && items.length === 0) {
      if (prompts.log && prompts.log.warn) prompts.log.warn('No pages found. Make sure you\'ve shared at least one page with your integration.');

      const retry = exitIfCancelled(
        await prompts.confirm({
          message: 'Share some pages in Notion, then try again?',
        })
      );

      if (!retry) {
        p.cancel('No pages to download.');
        throw new Error('No pages');
      }

      emptyFetchAttempts++;
      if (emptyFetchAttempts >= MAX_EMPTY_FETCH_ATTEMPTS) {
        p.log.error('No pages found after multiple attempts. Aborting.');
        throw new Error('No pages after retries');
      }

      continue;
    }

    const itemOptions = items.map((item) => {
      const isChecked = selectedItemsMap.has(item.id);
      const icon = item.type === 'database' ? '📁' : '📄';
      const check = isChecked ? '[X]' : '[ ]';

      return {
        value: item.id,
        label: `${check} ${icon} ${item.name}`,
      };
    });

    const options = [
      { value: 'ACTION_FINISH', label: '🚀 [🏁 FINISH SELECTION & START SYNC]' },
      ...(currentFolderId !== null
        ? [{ value: 'ACTION_GO_BACK', label: '🛑 [⬅ Go Back to Parent Folder]' }]
        : []),
      ...itemOptions,
    ];

    const breadcrumb = folderHistoryStack.map((f) => f.name).concat(currentFolderName).join(' / ');

    const chosen = exitIfCancelled(
      await prompts.select({
        message: `Browse: ${breadcrumb}`,
        options,
      })
    );

    if (chosen === 'ACTION_FINISH') {
      selected = Array.from(selectedItemsMap.values());
      if (selected.length === 0) {
        p.log.warn('No items selected yet. Select at least one page/database before finishing.');
        continue;
      }
      break;
    }

    if (chosen === 'ACTION_GO_BACK') {
      const prev = folderHistoryStack.pop();
      currentFolderId = prev?.id ?? null;
      currentFolderName = prev?.name ?? 'Notion Root';
      continue;
    }

    const clickedItem = items.find((it) => it.id === chosen);
    if (!clickedItem) continue;

    if (clickedItem.isFolder || clickedItem.type === 'database') {
      const action = exitIfCancelled(
        await prompts.select({
          message: `${clickedItem.name}: choose an action`,
          options: [
            { value: 'toggle', label: '1) Toggle selection for this entire directory' },
            { value: 'enter', label: '2) Enter directory to view sub-pages' },
            { value: 'cancel', label: 'Cancel' },
          ],
        })
      );

      if (action === 'toggle') {
        if (selectedItemsMap.has(clickedItem.id)) {
          selectedItemsMap.delete(clickedItem.id);
        } else {
          selectedItemsMap.set(clickedItem.id, { id: clickedItem.id, name: clickedItem.name, type: clickedItem.type });
        }
        continue;
      }

      if (action === 'enter') {
        folderHistoryStack.push({ id: currentFolderId, name: currentFolderName });
        currentFolderId = clickedItem.id;
        currentFolderName = clickedItem.name;
        continue;
      }

      continue;
    }

    // Standard page row: toggle selection directly.
    if (selectedItemsMap.has(clickedItem.id)) {
      selectedItemsMap.delete(clickedItem.id);
    } else {
      selectedItemsMap.set(clickedItem.id, { id: clickedItem.id, name: clickedItem.name, type: clickedItem.type });
    }
  }

  return selected;
}

/**
 * Extract a Notion ID from a raw input (URL or UUID). Returns a 32-char hex string
 * when possible, otherwise returns the original input.
 */
export function extractNotionId(input) {
  if (!input || typeof input !== 'string') return input;
  const re = /([a-f0-9]{8}-?[a-f0-9]{4}-?[a-f0-9]{4}-?[a-f0-9]{4}-?[a-f0-9]{12})|([a-f0-9]{32})/i;
  const m = input.match(re);
  if (!m) return input;
  const id = (m[1] || m[2] || '').replace(/-/g, '');
  return id;
}

const BANNER = `Notion Drive`;

export function parseArgs(argv) {
  const out = {
    source: null,
    out: null,
    help: false,
    token: null,
    sourceClip: false,
    debug: false,
    type: 'markdown',
    format: null,
    sync: null,
    syncMode: false,
    syncFilter: null,
    groupFilter: null,
    noCache: false,
    watchMode: false,
    statusMode: false,
    discoverMode: false,
    statusFilter: null,
    databaseId: null,
    dataSourceId: null,
    onlyStatus: null,
    excludeDisabled: false,
    sinceDays: null,
    jsonOutput: false,
    force: false,

    pushMode: false,
    pullMode: false,
    file: null,
    page: null,
    useCache: false,
    filename: null,
    frontmatter: null,
    title: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === 'discover') {
      out.discoverMode = true;
    } else if (a === '--database') {
      out.databaseFlagProvided = true;
      out.databaseId = extractNotionId(argv[i + 1]);
      i += 1;
    } else if (a === '--data-source') {
      out.dataSourceFlagProvided = true;
      out.dataSourceId = argv[i + 1];
      i += 1;
    } else if (a === 'sync') {
      out.syncMode = true;
      // Capture an immediate trailing positional filter (e.g. `notiondrive sync sys-design`)
      const next = argv[i + 1];
      if (next && typeof next === 'string' && !next.startsWith('-')) {
        out.syncFilter = next;
        i += 1;
      }
    } else if (a === 'push') {
      out.pushMode = true;
    } else if (a === 'pull') {
      out.pullMode = true;
    } else if (a === '--source' || a === '-s') {
      const raw = argv[i + 1];
      out.source = raw === '-' ? '-' : extractNotionId(raw);
      i += 1;
    } else if (a === 'status') {
      out.statusMode = true;
      // capture an immediate trailing positional filter (e.g. `notiondrive status sys-design`)
      const next = argv[i + 1];
      if (next && typeof next === 'string' && !next.startsWith('-')) {
        out.statusFilter = next;
        i += 1;
      }
    } else if (a === '--help' || a === '-h') {
      out.help = true;
    } else if (a === '--format') {
      out.format = argv[i + 1];
      i += 1;
    } else if (a === '--out' || a === '-o') {
      out.out = argv[i + 1];
      i += 1;
    } else if (a === '--set-default-out') {
      out.setDefaultOut = argv[i + 1];
      i += 1;
    } else if (a === '--source-clip') {
      out.sourceClip = true;
    } else if (a === '--debug' || a === '-d') {
      out.debug = true;
    } else if (a === '--token' || a === '-t') {
      out.token = argv[i + 1];
      i += 1;
    } else if (a === '--type') {
      out.type = argv[i + 1];
      i += 1;
    } else if (a === '--format') {
      out.format = argv[i + 1];
      i += 1;
    } else if (a === '--sync') {
      out.sync = argv[i + 1];
      i += 1;
    } else if (a === '--group' || a === '-g') {
      out.groupFilter = argv[i + 1];
      i += 1;
    } else if (a === '--only-status') {
      out.onlyStatus = argv[i + 1];
      i += 1;
    } else if (a === '--exclude-disabled') {
      out.excludeDisabled = true;
    } else if (a === '--since') {
      const raw = argv[i + 1];
      out.sinceDays = Number(raw);
      i += 1;
    } else if (a === '--json') {
      out.jsonOutput = true;
    } else if (a === '--no-cache') {
      out.noCache = true;
    } else if (a === '--use-cache') {
      out.useCache = true;
    } else if (a === '--file') {
      out.file = argv[i + 1];
      i += 1;
    } else if (a === '--page') {
      const raw = argv[i + 1];
      out.page = raw === '-' ? '-' : extractNotionId(raw);
      i += 1;
    } else if (a === '--filename') {
      out.filename = argv[i + 1];
      i += 1;
    } else if (a === '--frontmatter') {
      out.frontmatter = argv[i + 1];
      i += 1;
    } else if (a === '--title') {
      out.title = argv[i + 1];
      i += 1;
    } else if (a === '--force' || a === '-f') {
      out.force = true;
    } else if (a === '--watch' || a === '-w') {
      out.watchMode = true;
    }
  }

  return out;
}

function parseFrontmatterFlag(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value;
  const v = value.trim();
  if (!v) return null;
  if (v.toLowerCase() === 'true') return true;
  if (v.toLowerCase() === 'false') return false;
  return v;
}

export function createPushOverrideManifest({ filePath, page, frontmatter, title, format }) {
  const absFilePath = path.resolve(filePath);
  const outDir = path.dirname(absFilePath);
  const baseName = path.basename(absFilePath);
  return {
    targets: [
      {
        source: String(page),
        outDir,
        filename: baseName,
        sync: 'push-only',
        frontmatter: frontmatter === null ? undefined : parseFrontmatterFlag(frontmatter),
        title: title === null ? undefined : title,
        format: format || undefined,
      },
    ],
  };
}

export function createPullOverrideManifest({ page, outDir, filename, frontmatter, title, format }) {
  const absOutDir = path.resolve(outDir);
  return {
    targets: [
      {
        source: String(page),
        outDir: absOutDir,
        filename: filename || undefined,
        sync: 'pull-only',
        frontmatter: frontmatter === null ? undefined : parseFrontmatterFlag(frontmatter),
        title: title === null ? undefined : title,
        format: format || undefined,
      },
    ],
  };
}

/**
 * Merge config sources with project-local values taking precedence over user config.
 */
export function resolveConfigSources(projectConfig, savedConfig, envToken = null) {
  return {
    token: projectConfig?.token || savedConfig?.token || envToken || null,
    workspace: projectConfig?.workspace || savedConfig?.workspace || null,
    defaultOutputDir: projectConfig?.defaultOutputDir || savedConfig?.defaultOutputDir || null,
  };
}

/**
 * Choose the sync manifest source with project-local config taking precedence.
 * Falls back to the user config if the local file is missing or does not define targets.
 */
export function resolveSyncManifest(projectConfig, savedConfig) {
  if (Array.isArray(projectConfig?.targets) && projectConfig.targets.length > 0) {
    return projectConfig;
  }
  if (Array.isArray(savedConfig?.targets) && savedConfig.targets.length > 0) {
    return savedConfig;
  }
  return null;
}

export function resolveDiscoverySource(args, discoveryConfig = {}) {
  if (args.databaseFlagProvided && args.dataSourceFlagProvided) {
    return { error: 'Specify only one of --database or --data-source.' };
  }
  const databaseId = args.databaseFlagProvided ? args.databaseId : args.dataSourceFlagProvided ? null : discoveryConfig.databaseId;
  const dataSourceId = args.dataSourceFlagProvided ? args.dataSourceId : args.databaseFlagProvided ? null : discoveryConfig.dataSourceId;
  if ((!databaseId && !dataSourceId) || (databaseId && dataSourceId)) {
    return { error: 'Discovery requires exactly one databaseId/dataSourceId.' };
  }
  return { databaseId: databaseId || null, dataSourceId: dataSourceId || null };
}

export function getHeadlessExitCode(stats) {
  return stats?.errors?.length > 0 ? 1 : 0;
}

/**
 * Load notiondrive.config.json from current working directory.
 * Expects an object with targets array: [{ source, path?, format?, sync? }]
 * The `path` field may be a directory (generated filename) or a full file path.
 */
export function loadLocalManifest() {
  const manifestPath = path.join(process.cwd(), 'notiondrive.config.json');
  if (!existsSync(manifestPath)) {
    return null;
  }
  try {
    const raw = readFileSync(manifestPath, 'utf-8');
    const data = JSON.parse(raw);
    if (!(Array.isArray(data.targets) || Array.isArray(data.groups))) {
      throw new Error('Manifest must have a "targets" or "groups" array');
    }

    // Normalize grouped layout into a flat targets array for the rest of the engine
    return flattenManifest(data);
  } catch (err) {
    throw new Error(`Failed to load ${manifestPath}: ${err.message}`);
  }
}

async function runJsonDiscovery(args, projectConfig, savedConfig, envToken) {
  try {
    const discoveryConfig = projectConfig?.discovery || savedConfig?.discovery || {};
    const source = resolveDiscoverySource(args, discoveryConfig);
    const token = args.token || envToken || projectConfig?.token || savedConfig?.token || null;
    if (source.error || !token) throw new Error(source.error || 'Discovery requires exactly one databaseId/dataSourceId and a configured Notion token.');
    const root = await realpath(path.resolve(args.out || process.cwd()));
    const results = await discoverDocuments({ notion: new NotionClient(token), ...source, root, properties: discoveryConfig.properties, overrides: discoveryConfig.overrides || [] });
    console.log(JSON.stringify(results, null, 2));
    process.exitCode = results.some((item) => item.status !== 'mapped') ? 1 : 0;
  } catch (err) {
    console.log(JSON.stringify({ error: `Discovery failed: ${err.message}` }));
    process.exitCode = 1;
  }
}

export async function main(envToken = null) {
  const args = parseArgs(process.argv.slice(2));
  try {
    process.stdin.setMaxListeners(0);
  } catch (err) {}
  if (args.help) {
    console.log([
      'Usage: notiondrive [command] [options]',
      '',
      'Commands:',
      '  sync                  Run batch download from notiondrive.config.json or ~/.notiondrive/config.json',
      '  status                Show sync status for manifest targets (supports name or group filtering)',
      '  discover              Read-only database document inventory (--database <id> or --data-source <id> [--json])',
      '                        Project-local notiondrive.config.json takes precedence and can also provide token/defaultOutputDir',
      '                        You can limit which targets are processed by passing a positional filter',
      '                        after `sync` or by using the `--group` / `-g` flag.',
      '                        Use `--watch` or `-w` to continuously monitor tracked files for changes and',
      '                        automatically push them to Notion in real-time.',
      '                        Examples:',
      '                          notiondrive sync sys-design       # run targets named or grouped sys-design',
      '                          notiondrive sync -g docs          # run targets with group: "docs"',
      '                          notiondrive sync --watch          # start watching for file changes',
      '                          notiondrive push  --file ./Draft.md --page <pageIdOrUrl>',
      '                          notiondrive pull  --page <pageIdOrUrl> --out ./exports',
      '  push                  Upload a local Markdown file to a specific Notion page',
      '  pull                  Download a specific Notion page to a local folder',
      '',
      'Options:',
      '  -s, --source <id-or-url>  Specify an explicit Notion Page/Database UUID or full Share Link',
      '                       Use "-" to read the source id/url from stdin (pipe/echo)',
      '                       Use "--source-clip" to read the URL from the clipboard (macOS pbpaste)',
      '  -o, --out <path>      Specify a custom local directory output path (default: current directory; also used by `pull`)',
      '  -d, --debug           Enable verbose debug logging (helpful for troubleshooting)',
      '      --set-default-out <path>  Set and save the global default output directory and exit',
      '  -t, --token <token>     Set and save a Notion integration token',
      '      --no-cache          Do not read or write the local .notiondrive-state.json ledger (force fresh downloads)',
      '      --type <markdown|csv>  Output format for database exports (default: markdown)',
      '      --format <markdown-tree|flattened|csv>  Output format for targets and immediate downloads',
      '      --sync <pull-only|push-only|two-way>  Force sync mode for this run (when using --source) or for created targets',
      '      --force, -f           Bypass structural preflight when pushing to Notion (use with caution)',
      '  -g, --group <name>    Limit sync to targets with matching `group` in config',
        '      --only-status <status1,status2>  Show only targets matching these statuses (comma-separated)',
        '      --exclude-disabled             Exclude targets with "disabled": true from status output',
        '      --since <days>                 Show only targets changed within the last N days (remote or local)',
        '      --json                         Emit JSON output (for scripts)',
      '  -w, --watch           Enter watch mode: automatically push local file changes to Notion (requires sync mode)',

      'Push/pull flags:',
      '  push:  --file <local.md>  Local Markdown file to upload (required for `push`)',
      '         --page <id-or-url> Notion page/database UUID or full share URL (required for `push`)',
      '  pull:  --page <id-or-url> Notion page/database UUID or full share URL (required for `pull`)',
      '         --filename <name.md> Optional output filename (required filename only when `out` is a directory)',
      '  --frontmatter <key|true>  Enable YAML frontmatter handling (pull: generate file frontmatter; push: map into a Notion property)',
      '  --title <value>           Override how the page title is derived (for push/pull)',
      '  --use-cache               Allow cache usage for `push` overrides (default: skip cache for deterministic overrides)',

      '  -h, --help            Show this help information',
    ].join('\n'))
    process.exit(0);
  }
  
  // Enable debug mode early so other modules can check env var
  if (args.debug) {
    process.env.DEBUG = '1';
    if (!(args.discoverMode && args.jsonOutput)) p.log.info('Debug logging enabled (DEBUG=1)');
  }
  // JSON discovery takes the non-interactive path before any token validation or persistence.
  if (args.discoverMode && args.jsonOutput) {
    let projectConfig = null;
    let savedConfig = null;
    try {
      projectConfig = await loadProjectConfig();
      savedConfig = await loadConfig();
      await runJsonDiscovery(args, projectConfig, savedConfig, envToken);
    } catch (err) {
      console.log(JSON.stringify({ error: `Discovery failed: ${err.message}` }));
      process.exitCode = 1;
    }
    return;
  }

  // If the user asked to read the source id/url from stdin (pipe/echo), do that now.
  if (args.source === '-') {
    // Read all stdin
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const input = Buffer.concat(chunks).toString('utf8').trim();
    if (!input) {
      p.log.error('No input received on stdin for --source.');
      process.exit(1);
    }
    args.source = extractNotionId(input);
  }

  // If requested, read the source id/url from the system clipboard (macOS)
  // Handled later as part of headless (--source) flow to centralize clipboard access.
  if (!args.discoverMode || !args.jsonOutput) {
    console.log(BANNER);
    p.intro('notiondrive v0.1.2');
  }

  // ── Prepare config/token ──────────────────────────────────────────
  const projectConfig = await loadProjectConfig();
  const savedConfig = await loadConfig();
  const resolvedConfig = resolveConfigSources(projectConfig, savedConfig, envToken);
  let token = resolvedConfig.token;
  let workspaceName = resolvedConfig.workspace;
  const defaultOutputDir = resolvedConfig.defaultOutputDir;

  // If the user requested to set the default output directory via CLI, handle it now and exit.
  if (args.setDefaultOut) {
    const resolved = path.resolve(args.setDefaultOut);
    if (!(await isWritablePath(resolved))) {
      p.log.error(`Cannot write to "${resolved}". Check that the folder exists and you have permission.`);
      process.exit(1);
    }

    try {
      const newConfig = safeMerge({}, savedConfig || {}, { defaultOutputDir: resolved });
      await saveConfig(newConfig);
      p.log.success(`Saved default output directory to ~/.notiondrive/config.json: ${resolved}`);
      process.exit(0);
    } catch (err) {
      p.log.error(`Failed to save config: ${err.message}`);
      process.exit(1);
    }
  }

  // JSON discovery is handled before token validation or persistence.

  // If user supplied a new token via CLI flag, prefer and save it (after validation)
  let tokenSavedViaFlag = false;
  if (args.token) {
    token = args.token;
    p.log.info('Using token provided via --token flag (will validate and save).');
    const spinValidate = p.spinner();
    spinValidate.start('Validating token...');
    const tmpClient = new NotionClient(token);
    try {
      await tmpClient.validateToken();
      spinValidate.stop('Token valid.');
      // Save immediately
      await saveConfig({ token, workspace: savedConfig?.workspace });
      tokenSavedViaFlag = true;
      p.log.success('Token saved to ~/.notiondrive/config.json');
    } catch (err) {
      spinValidate.stop('Validation failed.');
      p.log.error('Provided token is invalid. Aborting.');
      process.exit(1);
    }
  }

  // Project-local config takes precedence over user config for shared settings.
  if (!token && projectConfig?.token) {
    token = projectConfig.token;
    workspaceName = projectConfig.workspace;
    p.log.info('Using token from ./notiondrive.config.json');
  }

  // Status subcommand: local-only summary of manifest vs ledger/remote
  if (args.statusMode) {
    try {
      const manifest = resolveSyncManifest(projectConfig, savedConfig);
      if (!manifest) {
        p.log.error('No sync targets found. Add a "targets" array to ./notiondrive.config.json or ~/.notiondrive/config.json.');
        process.exit(1);
      }
      token = token || envToken || null;
      await executeStatus(manifest, token, args);
      process.exit(0);
    } catch (err) {
      p.log.error(err.message || String(err));
      process.exit(1);
    }
  }

  if (args.discoverMode) {
    const discoveryConfig = projectConfig?.discovery || savedConfig?.discovery || {};
    const source = resolveDiscoverySource(args, discoveryConfig);
    token = token || savedConfig?.token || envToken || null;
    if (source.error || !token) {
      const message = source.error || 'Discovery requires exactly one databaseId/dataSourceId and a configured Notion token.';
      if (args.jsonOutput) console.log(JSON.stringify({ error: message }));
      else p.log.error(message);
      process.exit(1);
    }
    try {
      const notion = new NotionClient(token);
      const root = await realpath(path.resolve(args.out || process.cwd()));
      const results = await discoverDocuments({ notion, ...source, root, properties: discoveryConfig.properties, overrides: discoveryConfig.overrides || [] });
      if (args.jsonOutput) console.log(JSON.stringify(results, null, 2));
      else {
        for (const result of results) console.log(`${result.status === 'mapped' ? 'OK' : 'REVIEW'}\t${result.pageId || '(missing ID)'}\t${result.path || result.reason}\t${result.title}`);
        console.log(`\n${results.filter((item) => item.status === 'mapped').length} mapped; ${results.filter((item) => item.status !== 'mapped').length} require review.`);
      }
      process.exit(results.some((item) => item.status !== 'mapped') ? 1 : 0);
    } catch (err) {
      if (args.jsonOutput) console.log(JSON.stringify({ error: `Discovery failed: ${err.message}` }));
      else p.log.error(`Discovery failed: ${err.message}`);
      process.exit(1);
    }
  }

  // Use saved token silently if present (no interactive prompt)
  if (!token && savedConfig?.token) {
    token = savedConfig.token;
    workspaceName = savedConfig.workspace;
    p.log.info('Using saved token from ~/.notiondrive/config.json');
  }

  // If an env var token exists and no other token yet, prefer it but log.
  if (!token && envToken) {
    token = envToken;
    p.log.info('Using token from NOTION_TOKEN environment variable');
  }

  // ── Push/pull overrides ───────────────────────────────
  // These commands intentionally bypass manifest resolution and instead
  // build a one-off manifest target from CLI flags.
  if (args.pushMode || args.pullMode) {
    if (args.pushMode) {
      if (!args.file || !args.page) {
        p.log.error('Usage: notiondrive push --file <local.md> --page <pageIdOrUrl> [--frontmatter <key|true>] [--title <value>] [--format <markdown-tree|flattened|csv>] [--use-cache] [--force]');
        process.exit(1);
      }
    }
    if (args.pullMode) {
      if (!args.page || !args.out) {
        p.log.error('Usage: notiondrive pull --page <pageIdOrUrl> --out <dir> [--filename <name.md>] [--frontmatter <key|true>] [--title <value>] [--format <markdown-tree|flattened|csv>] [--force]');
        process.exit(1);
      }
    }

    if (!token) {
      p.log.error('No Notion token found. Set NOTION_TOKEN or save a token with the CLI (notiondrive --token <token>).');
      process.exit(1);
    }

    let validated;
    try {
      validated = new NotionClient(token);
      await validated.validateToken();
    } catch (err) {
      p.log.error(
        err?.status === 401
          ? 'Invalid token. Make sure you copied the "Internal Integration Secret", not the Integration ID.'
          : 'Could not connect to Notion. Check your internet connection and try again.'
      );
      process.exit(1);
    }

    const oneOffManifest = args.pushMode
      ? createPushOverrideManifest({
          filePath: args.file,
          page: args.page,
          frontmatter: args.frontmatter,
          title: args.title,
          format: args.format || undefined,
        })
      : createPullOverrideManifest({
          page: args.page,
          outDir: args.out,
          filename: args.filename,
          frontmatter: args.frontmatter,
          title: args.title,
          format: args.format || undefined,
        });

    const engineArgs = {
      debug: args.debug,
      force: args.force,
      noCache: args.pushMode ? !args.useCache : true,
    };

    const syncResult = await executeSyncMode(oneOffManifest, token, engineArgs);
    process.exit(syncResult && syncResult.failedTargets && syncResult.failedTargets.length > 0 ? 1 : 0);
  }

  // ── Sync mode: batch download from manifest ───────────────────────
  if (args.syncMode) {
    // Load manifest file (project-local config first, then user config fallback)
    try {
      const manifest = resolveSyncManifest(projectConfig, savedConfig);
      if (!manifest) {
        p.log.error('No sync targets found. Add a "targets" array to ./notiondrive.config.json or ~/.notiondrive/config.json.');
        p.log.info('Create one with this structure:');
        p.log.info(JSON.stringify({
          targets: [
              { source: 'https://notion.so/page-id-or-full-url', path: './output/MyPage', format: 'markdown-tree', sync: 'pull-only' },
            ],
        }, null, 2));
        process.exit(1);
      }
      // Warn if manifest contains explicitly disabled targets
      const disabledCount = (manifest.targets || []).filter((t) => t && t.disabled === true).length;
      if (disabledCount > 0) {
        p.log.warn(`Manifest contains ${disabledCount} disabled target${disabledCount === 1 ? '' : 's'}. These will be skipped during sync.`);
        p.log.info('Use "disabled": true on a target to temporarily disable it. Remove the flag to re-enable.');
      }
    } catch (err) {
      p.log.error(`${err.message}`);
      process.exit(1);
    }

    // Delegate to sync execution module
    token = token || envToken || null;
    
    // Check if watch mode is requested
    if (args.watchMode) {
      await startSyncWatchMode(resolveSyncManifest(projectConfig, savedConfig), token, args);
      // startSyncWatchMode handles shutdown, should not reach here unless error
      process.exit(0);
    } else {
      const syncResult = await executeSyncMode(resolveSyncManifest(projectConfig, savedConfig), token, args);
      process.exit(syncResult && syncResult.failedTargets && syncResult.failedTargets.length > 0 ? 1 : 0);
    }
  }

  // Headless mode: --source provided -> skip interactive prompts entirely
  if (args.source || args.sourceClip) {
    if (!args.source && args.sourceClip) {
      try {
        const proc = spawnSync('pbpaste', { encoding: 'utf8' });
        if (proc.error) {
          p.log.error('Failed to read clipboard.');
          process.exit(1);
        }
        const clip = String(proc.stdout || '').trim();
        if (!clip) {
          p.log.error('Clipboard is empty.');
          process.exit(1);
        }
        args.source = extractNotionId(clip);
      } catch {
        p.log.error('Failed to read clipboard.');
        process.exit(1);
      }
    }

    const spin = p.spinner();
    spin.start('Connecting to Notion...');

    const notion = new NotionClient(token);
    try {
      await notion.validateToken();
      spin.stop('Connected to Notion.');
    } catch (err) {
      spin.stop('Connection failed.');
      p.log.error(
        err.status === 401
          ? 'Invalid token. Make sure you copied the "Internal Integration Secret", not the Integration ID.'
          : 'Could not connect to Notion. Check your internet connection and try again.'
      );
      process.exit(1);
    }

    // Resolve target id (page or database) and fetch title
    let targetItem;
    try {
      const page = await notion.getPage(args.source);
      const name = extractTitle(page) || 'Exported-Page';
      if (name === 'Untitled') p.log.info(`Title lookup returned 'Untitled' for page ${args.source}; falling back to other heuristics.`);
      targetItem = { id: args.source, name, type: 'page' };
    } catch (errPage) {
      try {
        const db = await notion.getDatabase(args.source);
        const name = extractDatabaseTitle(db) || 'Exported-Database';
        targetItem = { id: args.source, name, type: 'database' };
      } catch (errDb) {
        p.log.error(`Could not fetch page or database with id "${args.source}". Ensure the ID is correct and shared with the integration.`);
        process.exit(1);
      }
    }

    // Resolve output path
    const savePath = path.resolve(args.out || defaultOutputDir || process.cwd());

    if (!(await isWritablePath(savePath))) {
      p.log.error(`Cannot write to "${savePath}". Check that the folder exists and you have permission.`);
      process.exit(1);
    }

    if (existsSync(savePath)) {
      p.log.info(`"${savePath}" already exists. New pages will be added, existing pages will be updated.`);
    }

    // Start download immediately with a single-item map
    spin.start('Starting download...');

    const chosenFormat = args.format || 'markdown-tree';
    const dlOpts = { format: chosenFormat, debug: args.debug, frontmatter: false };

    const stats = await downloadPages([ { id: targetItem.id, name: targetItem.name, type: targetItem.type } ], savePath, notion, {
      onStatus: (message) => spin.message(message),
      onLog: (message) => {
        spin.stop(message);
        spin.start('...');
      },
      onError: (message) => {
        spin.stop('');
        p.log.warn(message);
        spin.start('Continuing...');
      },
    }, dlOpts);

    spin.stop(`${stats.totalPages} page${stats.totalPages === 1 ? '' : 's'}, ${stats.totalAssets} asset${stats.totalAssets === 1 ? '' : 's'} downloaded.`);

    // Summary
    const summary = [`${stats.totalPages} page${stats.totalPages === 1 ? '' : 's'} downloaded`];
    if (stats.totalAssets > 0) summary.push(`${stats.totalAssets} file${stats.totalAssets === 1 ? '' : 's'} saved`);
    if (stats.errors.length > 0) summary.push(`${stats.errors.length} error${stats.errors.length === 1 ? '' : 's'}`);

    if (stats.errors.length > 0) {
      p.log.warn('Some items had errors:');
      for (const err of stats.errors) {
        p.log.warn(`  - ${err.title}: ${err.error}`);
      }
    }

    p.note(savePath, 'Saved to');
    p.outro(`Done! ${summary.join(', ')}.`);
    process.exit(getHeadlessExitCode(stats));
  }

  if (!token) {
    p.note(
      [
        '1. Open: https://www.notion.so/profile/integrations/internal/form/new-integration',
        '2. Fill in a name (e.g. "export-to-fs"), select your workspace',
        '   Note: the name cannot contain the word "notion"',
        '3. Under Capabilities:',
        '   - Content: check only "Read content", uncheck the rest',
        '   - Comments: uncheck all',
        '   - User capabilities: select "No user information"',
        '4. Click "Create" → copy the "Internal Integration Secret"',
      ].join('\n'),
      'Step 1: Create a Notion integration'
    );

    token = exitIfCancelled(
      await p.password({
        message: 'Paste your integration token:',
        validate: (val) => {
          if (!val) return 'Token is required.';
          if (!val.startsWith('ntn_') && !val.startsWith('secret_')) {
            return 'Token should start with "ntn_" (or "secret_" for older tokens).';
          }
        },
      })
    );
  }

  // ── Step 2: Validate token ────────────────────────────────────────
  const spin = p.spinner();
  spin.start('Connecting to Notion...');

  const notion = new NotionClient(token);

  try {
    await notion.validateToken();
    spin.stop('Connected to Notion.');
  } catch (err) {
    spin.stop('Connection failed.');
    p.log.error(
      err.status === 401
        ? 'Invalid token. Make sure you copied the "Internal Integration Secret", not the Integration ID.'
        : 'Could not connect to Notion. Check your internet connection and try again.'
    );
    process.exit(1);
  }

  // ── Step 3: Share pages with integration ──────────────────────────
  if (!savedConfig?.token || savedConfig.token !== token) {
    p.note(
      [
        'Now share ALL the pages you want to download:',
        '',
        '  1. Open a page in Notion',
        '  2. Click the ••• menu at the top right',
        '  3. Select "Connections"',
        '  4. Add your integration',
        '',
        'Repeat for each top-level page or database you want.',
        'Sharing a parent page automatically shares all its children.',
        '',
        'Don\'t worry if you miss some — you can add more later.',
      ].join('\n'),
      'Step 2: Share pages with your integration'
    );

    exitIfCancelled(
      await p.confirm({
        message: 'I\'ve shared my pages. Continue?',
      })
    );
  }

  // ── Step 3: Stateful drill-down selection ─────────────────────────
  const selected = await browseAndSelect(notion, savedConfig);

  // ── Step 5: Save location ─────────────────────────────────────────
  const locationOptions = getSaveLocationOptions();

  let savePath;

  const locationChoice = exitIfCancelled(
    await p.select({
      message: 'Where should we save the files?',
      options: locationOptions,
    })
  );

  if (locationChoice === 'custom') {
    const rawPath = exitIfCancelled(
      await p.text({
        message: 'Enter the full path:',
        validate: (val) => {
          if (!val?.trim()) return 'Path is required.';
        },
      })
    );
    savePath = path.resolve(rawPath);
  } else {
    savePath = locationChoice;
  }

  // Validate the path is writable
  if (!(await isWritablePath(savePath))) {
    p.log.error(`Cannot write to "${savePath}". Check that the folder exists and you have permission.`);
    process.exit(1);
  }

  // Ask if user wants to set this as default for future headless exports
  if (locationChoice === 'custom' || !locationOptions.some(opt => opt.value === savePath)) {
    const setAsDefault = exitIfCancelled(
      await p.confirm({
        message: 'Would you like to set this path as your global default for future headless exports?',
      })
    );

    if (setAsDefault) {
      try {
        await saveConfig({
          token: token || savedConfig?.token,
          workspace: workspaceName || savedConfig?.workspace,
          defaultOutputDir: savePath,
        });
        p.log.success(`Default output path saved: ${savePath}`);
      } catch {
        p.log.warn('Failed to save default path to config file.');
      }
    }
  }

  // Inform user about merge behavior if directory exists
  if (existsSync(savePath)) {
    p.log.info(`"${savePath}" already exists. New pages will be added, existing pages will be updated.`);
  }

  // ── Step 6: Confirm & Download ────────────────────────────────────
  const proceed = exitIfCancelled(
    await p.confirm({
      message: `Download ${selected.length} item${selected.length === 1 ? '' : 's'} to ${savePath}?`,
    })
  );

  if (!proceed) {
    p.cancel('Cancelled.');
    process.exit(0);
  }

  // Save token automatically if we prompted for it (no saved config existed)
  if (!savedConfig?.token && !tokenSavedViaFlag && token) {
    try {
      await saveConfig({ token, workspace: workspaceName });
      p.log.success('Token saved to ~/.notiondrive/config.json');
    } catch {
      p.log.warn('Failed to save token to config file.');
    }
  }

  // ── Download ──────────────────────────────────────────────────────
  spin.start('Starting download...');

  // Map CLI `format` to download options for interactive download
  const chosenFormatInt = args.format || 'markdown-tree';
  const dlOptsInt = { format: chosenFormatInt, debug: args.debug, frontmatter: false };

  const stats = await downloadPages(selected, savePath, notion, {
    onStatus: (message) => spin.message(message),
    onLog: (message) => {
      spin.stop(message);
      spin.start('...');
    },
    onError: (message) => {
      spin.stop('');
      p.log.warn(message);
      spin.start('Continuing...');
    },
  }, dlOptsInt);

  spin.stop(`${stats.totalPages} page${stats.totalPages === 1 ? '' : 's'}, ${stats.totalAssets} asset${stats.totalAssets === 1 ? '' : 's'} downloaded.`);

  // ── Summary ───────────────────────────────────────────────────────
  const summary = [`${stats.totalPages} page${stats.totalPages === 1 ? '' : 's'} downloaded`];
  if (stats.totalAssets > 0) {
    summary.push(`${stats.totalAssets} file${stats.totalAssets === 1 ? '' : 's'} saved`);
  }
  if (stats.errors.length > 0) {
    summary.push(`${stats.errors.length} error${stats.errors.length === 1 ? '' : 's'}`);
  }

  if (stats.errors.length > 0) {
    p.log.warn('Some items had errors:');
    for (const err of stats.errors) {
      p.log.warn(`  - ${err.title}: ${err.error}`);
    }
  }

  p.note(savePath, 'Saved to');
  p.outro(`Done! ${summary.join(', ')}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    p.log.error('Unexpected error. Please try again.');
    process.exit(1);
  });
}
