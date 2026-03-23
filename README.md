# mcp-dalamud

An [MCP](https://modelcontextprotocol.io/) server that exposes the [Dalamud](https://dalamud.dev) plugin API documentation to AI assistants. Compatible with any MCP-capable client (Claude Desktop, Cursor, Windsurf, VS Code with Copilot, etc.). Useful when writing FFXIV Dalamud plugins — ask your assistant about services, types, and methods without leaving your editor.

## Requirements

- Node.js 18+
- Any MCP-compatible AI assistant

## Setup

```bash
npm install
npm run build
```

Then register the server with your MCP client. The server communicates over **stdio** and takes no environment variables.

**Claude Desktop** (`%APPDATA%\Claude\claude_desktop_config.json` on Windows, `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "dalamud-api": {
      "command": "/path/to/node",
      "args": ["/path/to/mcp-dalamud/dist/index.js"]
    }
  }
}
```

**Cursor / Windsurf / other clients:** refer to your client's MCP documentation — the server entry is the same `command` + `args` pair above.

Restart your client after editing the config. On first launch the server crawls [dalamud.dev/api](https://dalamud.dev/api/) and writes a local cache to `cache/dalamud-api.json` (~96 namespaces, ~572 types). Subsequent starts load from disk instantly.

## Tools

| Tool | Description |
|------|-------------|
| `list_namespaces` | List all Dalamud API namespaces |
| `get_namespace` | List all types in a namespace |
| `get_type` | Full docs for a type — properties, methods, events, declarations |
| `search` | Keyword search across all types and summaries (max 100 results) |
| `refresh_cache` | Re-crawl dalamud.dev and rebuild the cache |

### Example prompts

- *"What services are available in Dalamud.Plugin.Services?"*
- *"Show me IClientState — what properties does it have?"*
- *"Search for anything related to inventory"*
- *"How do I register a slash command in Dalamud?"*

These work with any MCP-capable assistant that supports tool use.

## How it works

**Startup:** loads the cache from disk, or crawls dalamud.dev if missing/outdated. Also checks the [Dalamud GitHub releases](https://github.com/goatcorp/Dalamud/releases) in the background — if a new version is detected, the cache rebuilds automatically.

**Cache versioning:** the cache carries a version field. If the on-disk cache was built by an older version of this server, it is discarded and rebuilt on the next startup.

**Lazy member loading:** namespace and type indexes are cached upfront. Individual member details (properties, methods, etc.) are fetched on demand the first time `get_type` is called for a type, then persisted to cache.

## Development

```bash
npm run dev     # TypeScript watch mode
npm test        # Run tests (Vitest)
npm run build   # Compile to dist/
```

Tests cover `search`, `findType`, `findNamespace`, `normalizeKind`, and `isValidCache` — the core pure-function logic. The crawler itself (network I/O) is not unit-tested.

## Project structure

```
src/
  index.ts       # MCP server, tool handlers
  crawler.ts     # Crawling, caching, types
  search.ts      # findType, findNamespace, search
  __tests__/
    crawler.test.ts
    search.test.ts
cache/
  dalamud-api.json   # generated, not committed
```
