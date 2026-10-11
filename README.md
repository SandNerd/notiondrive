## Notion Drive

Download your Notion content to local Markdown files.

### Quick Start

- One-shot run:

  ```bash
  npx notiondrive
  ```

- After global install:

  ```bash
  npm install -g notiondrive
  notiondrive
  ```

### Developer Docs

- Architecture and module map: [docs/ARCH.md](docs/ARCH.md)
- Spec (manifest, ledger, markers): [docs/SPEC.md](docs/SPEC.md)
- Detailed README (full documentation): [docs/README_DETAILED.md](docs/README_DETAILED.md)

### Read-only database discovery

Configure a `discovery` object in `notiondrive.config.json` to inventory database documents without changing local files or Notion:

```json
{
  "discovery": {
    "databaseId": "<notion-database-id>",
    "properties": { "filename": "Name", "directory": "Repository Directory" },
    "overrides": [{ "pageId": "<notion-page-id>", "path": "docs/special-name.md" }]
  }
}
```

Run `notiondrive discover --json` for deterministic JSON, or `notiondrive discover --database <id> --out <repository-root>` for a human-readable inventory. Configure exactly one of `databaseId` or `dataSourceId`. Invalid or ambiguous records are reported as requiring review; discovery never synchronizes documents.
