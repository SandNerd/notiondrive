# NotionDrive architecture

## Modules and flow

`bin/cli.js` enters `src/cli.js`, which parses options, loads project/user configuration and routes commands. `src/config.js` handles saved settings and manifests. `src/notion.js` and `src/notion-helpers.js` provide API access and response helpers.

`src/discovery.js` queries a configured Notion database/data source, validates paginated metadata and page identities, derives repository-relative paths, applies page-ID overrides and checks filesystem containment/collisions. The CLI renders human-readable or JSON inventory.

`src/planner.js` consumes discovery results, Git/filesystem evidence, remote page content/revisions and the ledger reader from `src/state.js`. It reports classifications and reasons without applying them. Inadequate historical baseline evidence remains unknown; matching timestamps or filenames do not establish synchronization.

Downloads and synchronization are separate. `src/download.js` renders and writes local content; `src/parser.js` and `src/fetch-stream.js` support conversion and asset handling. `src/sync.js` coordinates sync/status/watch operations. In push-only, two-way, and watch flows, its push path can replace Notion page content (with a guard for rich Notion structures); pull/download paths write local Markdown. Successful sync paths also persist synchronization metadata through `src/state.js`. These are separate effects: remote page writes, local Markdown writes, and local ledger persistence. Discovery and planning do not invoke these writers.

## Credentials and state

Credentials are read from environment or saved CLI configuration; explicit `--token` is intended for setup on ordinary commands. Read-only discovery/planning do not persist credentials or alter configuration. The local sync ledger is written by sync flows and read by planning. Notion discovery/planning use read requests only.

RRE-871 synchronization write-safety work is maintained independently. These documents describe current repository behavior and do not assume unmerged changes or a future ledger contract.

## Development and CI

Run `npm ci`, `npm test`, `npx @rigour-labs/cli check`, and `git diff --check` from the repository root. GitHub Actions runs `npm ci` and `npm test` for PRs with `contents: read` permission.
