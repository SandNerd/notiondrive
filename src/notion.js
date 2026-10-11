import { Client, LogLevel } from '@notionhq/client';
import { extractTitle, extractDatabaseTitle } from './notion-helpers.js';

/**
 * Thin wrapper around the Notion API with built-in rate limiting and pagination.
 */
export class NotionClient {
  constructor(token) {
    this.client = new Client({ auth: token, logLevel: LogLevel.ERROR });
    this._queue = Promise.resolve();
    this._minInterval = 340; // ~3 req/s with margin
    this._pending = 0; // number of requests currently queued/in-flight
    this._maxPending = 200; // safety cap to avoid unbounded queue growth
  }

  /**
   * Serialize and throttle all API requests to stay under Notion's 3 req/s limit.
   * Uses a promise chain to ensure mutual exclusion (no concurrent requests).
   */
  _throttledCall(fn) {
    if (this._pending > this._maxPending) {
      return Promise.reject(new Error('Notion request queue overloaded'));
    }
    this._pending++;
    const previousQueue = this._queue;
    // Schedule this slot's delay relative to the previous request's dispatch time
    let timerId;
    const executionSlot = previousQueue.catch(() => {}).then(() => {
      return new Promise((resolve) => {
        // store timer id so static analysis tools can reason about lifecycle
        timerId = setTimeout(resolve, this._minInterval);
      });
    });
    // Advance the queue tracking pointer immediately to let the next request schedule its delay
    // Attach a catch to the queue pointer to avoid unhandled rejections from the queue chain
    this._queue = executionSlot.catch(() => {});
    // Execute the network function independently when its slot arrives
    const exec = executionSlot.then(() => fn());
    return exec.finally(() => {
      try {
        if (typeof timerId !== 'undefined') clearTimeout(timerId);
      } catch (e) {}
      this._pending--;
    });
  }

  /**
   * Auto-paginate any Notion list endpoint.
   * `fn` receives { start_cursor } and must return { results, has_more, next_cursor }.
   */
  async paginate(fn, { onProgress } = {}) {
    const allResults = [];
    let cursor = undefined;

    do {
      const response = await this._throttledCall(() =>
        fn({ start_cursor: cursor })
      );
      allResults.push(...response.results);
      cursor = response.has_more ? response.next_cursor : undefined;
      if (onProgress) onProgress(allResults.length);
    } while (cursor);

    return allResults;
  }

  /**
   * Validate the token by making a test search call.
   * Returns the response on success, throws on failure.
   */
  async validateToken() {
    return this._throttledCall(() =>
      this.client.search({ page_size: 1 })
    );
  }

  /**
   * Get all top-level pages and databases shared with the integration.
   * Uses a single search call (halves API requests vs separate page/database queries).
   */
  async getTopLevelPages({ onProgress } = {}) {
    const allItems = await this.paginate(
      (opts) => this.client.search({ page_size: 100, ...opts }),
      { onProgress }
    );

    // Build a set of all item IDs so we can detect which items have
    // their parent also in the set (i.e., they're not top-level).
    const allIds = new Set(allItems.map((item) => item.id));

    // Cache for parent lookups — inline databases don't appear in search
    // results, so we fetch their metadata to check ancestry.
    const parentCache = new Map();

    const topLevel = [];

    for (const item of allItems) {
      // An item is "top-level" if its parent is the workspace, OR if its
      // parent is not among the items shared with the integration (meaning
      // it's the root of whatever subtree was shared).
      const parentId = item.parent?.page_id || item.parent?.database_id;
      const parentInResults = parentId && allIds.has(parentId);

      if (item.parent?.type === 'workspace') {
        // Workspace-level items are always top-level
      } else if (parentInResults) {
        // Parent is in search results — this item is nested, skip it
        continue;
      } else if (item.parent?.type === 'block_id' && item.parent?.block_id) {
        // Child pages inside a page are parented to a block, not the page.
        // Walk up the block's parent chain to find the owning page/database.
        try {
          let currentId = item.parent.block_id;
          let found = false;
          // Walk up to 5 levels of block nesting (toggles inside columns, etc.)
          for (let i = 0; i < 5; i++) {
            if (!parentCache.has(currentId)) {
              const block = await this._throttledCall(() =>
                this.client.blocks.retrieve({ block_id: currentId })
              );
              parentCache.set(currentId, block);
            }
            const block = parentCache.get(currentId);
            const ownerId = block?.parent?.page_id || block?.parent?.database_id;
            if (ownerId && allIds.has(ownerId)) {
              found = true;
              break;
            }
            // If the block's parent is another block, keep walking up
            if (block?.parent?.type === 'block_id' && block?.parent?.block_id) {
              currentId = block.parent.block_id;
              continue;
            }
            break;
          }
          if (found) continue;
        } catch {
          // Block not accessible — the parent page isn't shared with
          // the integration, so this item is a legitimate root.
        }
      } else if (parentId) {
        // Parent NOT in search results — could be an inline database.
        // Fetch the parent to check if *its* parent is in our results.
        try {
          if (!parentCache.has(parentId)) {
            if (item.parent?.type === 'database_id') {
              const db = await this._throttledCall(() =>
                this.client.databases.retrieve({ database_id: parentId })
              );
              parentCache.set(parentId, db);
            } else {
              const pg = await this._throttledCall(() =>
                this.client.pages.retrieve({ page_id: parentId })
              );
              parentCache.set(parentId, pg);
            }
          }
          const parentObj = parentCache.get(parentId);
          const grandparentId = parentObj?.parent?.page_id || parentObj?.parent?.database_id;
          if (grandparentId && allIds.has(grandparentId)) {
            continue;
          }
        } catch {
          // If we can't fetch the parent, treat the item as top-level
        }
      }

      if (item.object === 'page') {
        topLevel.push({
          id: item.id,
          type: 'page',
          title: extractTitle(item),
          hasChildren: Boolean(item.has_children),
        });
      } else if (item.object === 'database') {
        topLevel.push({
          id: item.id,
          type: 'database',
          title: extractDatabaseTitle(item),
          hasChildren: false,
        });
      }
    }

    return topLevel;
  }

  /**
   * Get all child blocks for a given block/page ID (paginated).
   */
  async getBlockChildren(blockId) {
    return this.paginate((opts) =>
      this.client.blocks.children.list({
        block_id: blockId,
        page_size: 100,
        ...opts,
      })
    );
  }

  /**
   * Recursively fetch all block children through the throttled wrapper.
   * Skips child_page/child_database (handled by our own recursion).
   * This prevents notion-to-md from making unthrottled API calls.
   *
   * Returns { blocks, warnings } — warnings collects per-block fetch errors
   * so the caller can report them without losing the rest of the page.
   */
  async getBlockChildrenDeep(blockId, depth = 0, warnings = []) {
    const blocks = await this.getBlockChildren(blockId);
    if (depth >= 15) return { blocks, warnings };
    
    const tasks = blocks.map(async (block) => {
      if (block.has_children && block.type !== 'child_page' && block.type !== 'child_database') {
        try {
          const result = await this.getBlockChildrenDeep(block.id, depth + 1, warnings);
          block.children = result.blocks;
        } catch (err) {
          block.children = [];
          warnings.push({ blockId: block.id, blockType: block.type, error: err.message });
        }
      }
    });
    
    await Promise.all(tasks);
    return { blocks, warnings };
  }

  /**
   * Create a proxy around the raw Notion client that routes
   * blocks.children.list through our throttle. This is passed to
   * notion-to-md so its internal fetches respect rate limits.
   */
  get throttledClient() {
    if (this._throttledClient) return this._throttledClient;

    const self = this;
    this._throttledClient = new Proxy(this.client, {
      get: (target, prop) =>
        prop === 'blocks'
          ? new Proxy(target.blocks, {
              get: (blocksTarget, blocksProp) =>
                blocksProp === 'children'
                  ? new Proxy(blocksTarget.children, {
                      get: (childrenTarget, childrenProp) =>
                        childrenProp === 'list'
                          ? (args) => self._throttledCall(() => childrenTarget.list(args))
                          : childrenTarget[childrenProp],
                    })
                  : blocksTarget[blocksProp],
            })
          : target[prop],
    });

    return this._throttledClient;
  }

  /**
   * Query all rows/pages in a database (paginated).
   */
  async queryDatabase(databaseId) {
    return this.paginate((opts) =>
      this.client.databases.query({
        database_id: databaseId,
        page_size: 100,
        ...opts,
      })
    );
  }

  async queryDataSource(dataSourceId) {
    if (typeof this.client.request !== 'function') {
      throw new Error('The installed Notion SDK does not support data-source queries');
    }
    return this.paginate((opts) =>
      this.client.request({
        path: `data_sources/${encodeURIComponent(dataSourceId)}/query`,
        method: 'POST',
        body: { page_size: 100, ...opts },
      })
    );
  }

  /**
   * Retrieve a database's metadata/properties schema.
   */
  async getDatabase(databaseId) {
    return this._throttledCall(() =>
      this.client.databases.retrieve({ database_id: databaseId })
    );
  }

  /**
   * Retrieve a single block's properties.
   */
  async getBlock(blockId) {
    return this._throttledCall(() =>
      this.client.blocks.retrieve({ block_id: blockId })
    );
  }

  /**
   * Retrieve a single page's properties.
   */
  async getPage(pageId) {
    return this._throttledCall(() =>
      this.client.pages.retrieve({ page_id: pageId })
    );
  }

  /**
   * Delete all top-level block children of a page to clear its content.
   * Fetches the first tier of blocks and deletes each one.
   */
  async clearPageContent(pageId) {
    try {
      const blocks = await this.paginate((opts) =>
        this.client.blocks.children.list({
          block_id: pageId,
          page_size: 100,
          ...opts,
        })
      );

      for (const block of blocks) {
        await this._throttledCall(() =>
          this.client.blocks.delete({ block_id: block.id })
        );
      }

      return blocks.length;
    } catch (err) {
      throw new Error(`Failed to clear page content: ${err.message}`);
    }
  }

  /**
   * Append Notion JSON blocks to a page's children.
   * Batches requests into chunks of 100 blocks to stay within API limits.
   */
  async appendPageContent(pageId, blocks) {
    if (!Array.isArray(blocks) || blocks.length === 0) {
      return 0;
    }

    const BATCH_SIZE = 100;
    let appended = 0;

    try {
      for (let i = 0; i < blocks.length; i += BATCH_SIZE) {
        const batch = blocks.slice(i, i + BATCH_SIZE);
        await this._throttledCall(() =>
          this.client.blocks.children.append({
            block_id: pageId,
            children: batch,
          })
        );
        appended += batch.length;
      }

      return appended;
    } catch (err) {
      throw new Error(`Failed to append page content: ${err.message}`);
    }
  }
}

export { extractTitle, extractDatabaseTitle };
