# NotionDrive specification

NotionDrive is a Node.js CLI for downloading selected Notion content as Markdown. Project configuration (`notiondrive.config.json`) and saved user configuration provide targets and database discovery settings.

## Commands

- `notiondrive` starts the configured or interactive download flow.
- `notiondrive discover [--database <id> | --data-source <id>] [--json]` inventories database pages using configured filename/directory properties and optional page-ID overrides. Invalid or ambiguous paths require review. This command is read-only.
- `notiondrive plan [--database <id> | --data-source <id>] [--json]` compares discovery, Notion revisions/content, repository/Git evidence and the local sync ledger. It reports classifications only; it does not apply changes. Missing files are never restored automatically.
- `notiondrive --token <token>` is the explicit credential setup path for ordinary download/sync commands. Discovery and planning do not persist credentials.
- Sync/status/watch options operate on configured targets. Push-only and two-way sync can replace existing Notion page content; pull/download paths can write local Markdown, and sync persists ledger state. Watch repeats synchronization behavior, including its applicable remote and local writes. These operations are distinct from read-only discovery and planning and are not non-destructive.

## Trust and safety

Discovery derives repository-relative destinations from database properties. Overrides identify pages by stable Notion page ID. Invalid identities, unsupported metadata, traversal, symlink escapes and destination collisions require review rather than guessed mappings.

The planner does not claim `IN_SYNC` without trustworthy evidence for both local and remote rendered content. Historical ledger entries without sufficient remote comparison evidence remain `UNTRACKED`; frontmatter inputs that cannot be compared are handled conservatively. Git-reported rename/deletion evidence and a difference between the discovered path and a trusted ledger path are review signals, not proof of content equivalence.

Discovery and planning do not write Notion, Markdown, configuration or ledger state. Synchronization is separately mutating and its safety remains owned by the sync implementation; no planner result itself authorizes restoring, replacing or deleting content.

## Developer checks

From the repository root, run `npm ci`, `npm test`, `npx @rigour-labs/cli check`, and `git diff --check`.
