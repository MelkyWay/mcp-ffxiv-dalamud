import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  buildCache,
  ensureMembers,
  fetchLatestDalamudTag,
  getOrBuildCache,
  saveCache,
  type DalamudCache,
} from "./crawler.js";
import { findNamespace, findType, search } from "./search.js";
import { MEMBER_KIND_ORDER, groupMembersByKind } from "./type-members.js";

let cache: DalamudCache;

const server = new Server(
  { name: "dalamud-api", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_namespaces",
      description:
        "List all Dalamud API namespaces available in the documentation.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_namespace",
      description:
        "List all types (classes, interfaces, enums, etc.) in a specific Dalamud namespace.",
      inputSchema: {
        type: "object",
        properties: {
          namespace: {
            type: "string",
            description:
              'Namespace name, e.g. "Dalamud.Plugin.Services" or "Dalamud.Game.ClientState"',
          },
        },
        required: ["namespace"],
      },
    },
    {
      name: "get_type",
      description:
        "Get full documentation for a Dalamud type including all properties, methods, and events.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              'Type name (simple or namespace-qualified), e.g. "IClientState" or "Dalamud.Plugin.Services.IClientState"',
          },
        },
        required: ["name"],
      },
    },
    {
      name: "search",
      description:
        "Search the Dalamud API documentation by keyword. Returns matching types from all namespaces.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query, e.g. \"party\", \"inventory\", \"chat\"",
          },
          limit: {
            type: "number",
            description: "Maximum number of results to return (default: 20)",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "refresh_cache",
      description:
        "Re-crawl dalamud.dev and rebuild the local documentation cache. Use when docs seem outdated.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "list_namespaces") {
    const lines = cache.namespaces.map(
      (ns) => `${ns.name} (${ns.types.length} types)`
    );
    return {
      content: [
        {
          type: "text",
          text:
            `# Dalamud API Namespaces (${cache.namespaces.length} total)\n\n` +
            lines.join("\n"),
        },
      ],
    };
  }

  if (name === "get_namespace") {
    const nsName = typeof (args as any)?.namespace === "string" ? (args as any).namespace : null;
    if (!nsName) {
      return { content: [{ type: "text", text: 'Missing required argument: "namespace"' }], isError: true };
    }
    const ns = findNamespace(cache, nsName);

    if (!ns) {
      return {
        content: [
          {
            type: "text",
            text: `Namespace "${nsName}" not found. Use list_namespaces to see all available namespaces.`,
          },
        ],
        isError: true,
      };
    }

    const grouped: Record<string, typeof ns.types> = {};
    for (const t of ns.types) {
      const k = t.kind || "unknown";
      if (!grouped[k]) grouped[k] = [];
      grouped[k].push(t);
    }

    let text = `# ${ns.name}\n\n`;
    for (const [kind, types] of Object.entries(grouped)) {
      text += `## ${capitalize(kind)}s\n\n`;
      for (const t of types) {
        text += `### ${t.name}\n`;
        if (t.summary) text += `${t.summary}\n`;
        text += `URL: ${t.url}\n\n`;
      }
    }

    return { content: [{ type: "text", text }] };
  }

  if (name === "get_type") {
    const typeName = typeof (args as any)?.name === "string" ? (args as any).name : null;
    if (!typeName) {
      return { content: [{ type: "text", text: 'Missing required argument: "name"' }], isError: true };
    }
    const typeEntry = findType(cache, typeName);

    if (!typeEntry) {
      // Try a search to suggest alternatives
      const suggestions = search(cache, typeName, 5);
      const suggestionText =
        suggestions.length > 0
          ? `\n\nDid you mean one of these?\n${suggestions.map((r) => `- ${r.type.namespace}.${r.type.name}`).join("\n")}`
          : "";
      return {
        content: [
          {
            type: "text",
            text: `Type "${typeName}" not found.${suggestionText}`,
          },
        ],
        isError: true,
      };
    }

    // Lazy-load members if not already loaded
    if (!typeEntry.membersLoaded) {
      await ensureMembers(typeEntry);
      saveCache(cache); // always saves current global, not a stale reference
    }

    let text = `# ${typeEntry.kind === "unknown" ? "" : capitalize(typeEntry.kind) + " "}${typeEntry.name}\n`;
    text += `**Namespace:** ${typeEntry.namespace}\n`;
    text += `**URL:** ${typeEntry.url}\n\n`;

    if (typeEntry.summary) {
      text += `${typeEntry.summary}\n\n`;
    }

    const members = typeEntry.members || [];
    if (members.length === 0) {
      text += "_No members documented._\n";
    } else {
      const grouped = groupMembersByKind(members);
      for (const kind of MEMBER_KIND_ORDER) {
        if (!grouped[kind]) continue;
        text += `## ${capitalize(kind)}s\n\n`;
        for (const m of grouped[kind]) {
          text += `### ${m.name}\n`;
          if (m.summary) text += `${m.summary}\n\n`;
          if (m.declaration) text += `\`\`\`csharp\n${m.declaration}\n\`\`\`\n\n`;
        }
      }
    }

    return { content: [{ type: "text", text }] };
  }

  if (name === "search") {
    const query = typeof (args as any)?.query === "string" ? (args as any).query : null;
    if (!query) {
      return { content: [{ type: "text", text: 'Missing required argument: "query"' }], isError: true };
    }
    const rawLimit = (args as any)?.limit;
    const limit = Number.isFinite(rawLimit) ? rawLimit : 20;
    const results = search(cache, query, limit);

    if (results.length === 0) {
      return {
        content: [{ type: "text", text: `No results found for "${query}".` }],
      };
    }

    let text = `# Search results for "${query}" (${results.length} found)\n\n`;
    for (const r of results) {
      text += `## ${r.type.namespace}.${r.type.name}\n`;
      text += `**Kind:** ${r.type.kind}\n`;
      if (r.type.summary) text += `${r.type.summary}\n`;
      text += `URL: ${r.type.url}\n\n`;
    }

    return { content: [{ type: "text", text }] };
  }

  if (name === "refresh_cache") {
    process.stderr.write("[dalamud-mcp] Refreshing cache on user request...\n");
    cache = await buildCache();
    return {
      content: [
        {
          type: "text",
          text: `Cache refreshed. Found ${cache.namespaces.length} namespaces with ${cache.namespaces.reduce((a, n) => a + n.types.length, 0)} total types.`,
        },
      ],
    };
  }

  return {
    content: [{ type: "text", text: `Unknown tool: ${name}` }],
    isError: true,
  };
});

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

async function checkForDalamudUpdate(): Promise<void> {
  const latestTag = await fetchLatestDalamudTag();
  if (!latestTag) return;

  if (latestTag === cache.dalamudVersion) {
    process.stderr.write(
      `[dalamud-mcp] Cache up to date (${latestTag})\n`
    );
    return;
  }

  process.stderr.write(
    `[dalamud-mcp] New Dalamud release detected (${latestTag}), rebuilding cache in background...\n`
  );
  cache = await buildCache();
  process.stderr.write("[dalamud-mcp] Background cache refresh complete\n");
}

async function main() {
  cache = await getOrBuildCache();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[dalamud-mcp] MCP server running on stdio\n");

  // Background release check — non-blocking
  checkForDalamudUpdate().catch((e) => {
    process.stderr.write(`[dalamud-mcp] Update check failed: ${e}\n`);
  });
}

main().catch((e) => {
  process.stderr.write(`[dalamud-mcp] Fatal error: ${e}\n`);
  process.exit(1);
});
