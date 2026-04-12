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
  type Member,
} from "./crawler.js";
import { findNamespace, findType, search, searchMembers } from "./search.js";
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
    {
      name: "health",
      description:
        "Return cache status: build time, Dalamud version, namespace/type counts, and lazy-member coverage. Use to decide whether to call refresh_cache.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "search_members",
      description:
        "Search for specific members (properties, methods, fields, events, constructors) across all types that have already been loaded. Fast — no network access required. Gets more useful over time as more types are fetched via get_type.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Member name or summary keyword" },
          kind: {
            type: "string",
            enum: ["constructor", "property", "field", "method", "event", "unknown"],
            description: "Filter to a specific member kind",
          },
          namespace: { type: "string", description: 'Restrict to an exact namespace, e.g. "Dalamud.Plugin.Services"' },
          limit: { type: "number", description: "Maximum results (default: 20, max: 50)" },
        },
        required: ["query"],
      },
    },
    {
      name: "get_member",
      description:
        "Get full documentation for a specific member on a Dalamud type. Fetches the type's members if not already loaded.",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", description: 'Type name, e.g. "IClientState" or "Dalamud.Plugin.Services.IClientState"' },
          member: { type: "string", description: 'Member name (case-insensitive), e.g. "LocalPlayer"' },
        },
        required: ["type", "member"],
      },
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

  if (name === "health") {
    const totalTypes = cache.namespaces.reduce((a, ns) => a + ns.types.length, 0);
    const loadedTypes = cache.namespaces.reduce(
      (a, ns) => a + ns.types.filter((t) => t.membersLoaded).length, 0
    );
    const ageMs = Date.now() - new Date(cache.builtAt).getTime();
    const ageDays = Math.floor(ageMs / 86_400_000);
    const ageHours = Math.floor((ageMs % 86_400_000) / 3_600_000);

    let text = `# Cache Health\n\n`;
    text += `**Built:** ${cache.builtAt}`;
    text += ageDays > 0 ? ` (${ageDays}d ${ageHours}h ago)\n` : ` (${ageHours}h ago)\n`;
    if (cache.dalamudVersion) text += `**Dalamud version:** ${cache.dalamudVersion}\n`;
    text += `**Namespaces:** ${cache.namespaces.length}\n`;
    text += `**Types:** ${totalTypes}\n`;
    text += `**Members loaded:** ${loadedTypes}/${totalTypes} types (${Math.round((loadedTypes / totalTypes) * 100)}%)\n`;

    return { content: [{ type: "text", text }] };
  }

  if (name === "search_members") {
    const query = typeof (args as any)?.query === "string" ? (args as any).query : null;
    if (!query) {
      return { content: [{ type: "text", text: 'Missing required argument: "query"' }], isError: true };
    }
    const rawKind = (args as any)?.kind;
    if (rawKind !== undefined && !MEMBER_KIND_ORDER.includes(rawKind)) {
      return { content: [{ type: "text", text: `Invalid kind "${rawKind}". Must be one of: ${MEMBER_KIND_ORDER.join(", ")}` }], isError: true };
    }
    const kind = rawKind as Member["kind"] | undefined;
    const namespace = typeof (args as any)?.namespace === "string" ? (args as any).namespace : undefined;
    const rawLimit = (args as any)?.limit;
    const limit = Number.isFinite(rawLimit) ? rawLimit : 20;
    const results = searchMembers(cache, query, { kind, namespace, limit });

    if (results.length === 0) {
      return {
        content: [{ type: "text", text: `No members matching "${query}" found in loaded types.\n\nUse get_type on a type first to load its members, then retry.` }],
      };
    }

    let text = `# Member search results for "${query}" (${results.length} found)\n\n`;
    for (const r of results) {
      text += `## ${r.ownerName}.${r.member.name}\n`;
      text += `**Kind:** ${r.member.kind}  **Type:** ${r.ownerNamespace}.${r.ownerName}\n`;
      text += `**URL:** ${r.ownerUrl}\n`;
      if (r.member.summary) text += `${r.member.summary}\n`;
      if (r.member.declaration) text += `\`\`\`csharp\n${r.member.declaration}\n\`\`\`\n`;
      text += "\n";
    }
    return { content: [{ type: "text", text }] };
  }

  if (name === "get_member") {
    const typeName = typeof (args as any)?.type === "string" ? (args as any).type : null;
    if (!typeName) {
      return { content: [{ type: "text", text: 'Missing required argument: "type"' }], isError: true };
    }
    const memberName = typeof (args as any)?.member === "string" ? (args as any).member : null;
    if (!memberName) {
      return { content: [{ type: "text", text: 'Missing required argument: "member"' }], isError: true };
    }

    const typeEntry = findType(cache, typeName);
    if (!typeEntry) {
      const suggestions = search(cache, typeName, 5);
      const suggestionText = suggestions.length > 0
        ? `\n\nDid you mean one of these?\n${suggestions.map((r) => `- ${r.type.namespace}.${r.type.name}`).join("\n")}`
        : "";
      return { content: [{ type: "text", text: `Type "${typeName}" not found.${suggestionText}` }], isError: true };
    }

    if (!typeEntry.membersLoaded) {
      await ensureMembers(typeEntry);
      saveCache(cache);
    }

    const member = (typeEntry.members ?? []).find(
      (m) => (m.name ?? "").toLowerCase() === memberName.toLowerCase()
    );

    if (!member) {
      const grouped = groupMembersByKind(typeEntry.members ?? []);
      const total = (typeEntry.members ?? []).length;
      let text = `Member "${memberName}" not found on ${typeEntry.name}.\n\n`;
      if (total === 0) {
        text += "_No members documented._\n";
      } else {
        text += `**Available members** (${total} total):\n`;
        let shown = 0;
        for (const kind of MEMBER_KIND_ORDER) {
          if (!grouped[kind] || shown >= 10) break;
          text += `\n### ${capitalize(kind)}s\n`;
          for (const m of grouped[kind]) {
            if (shown >= 10) break;
            text += `- ${m.name}\n`;
            shown++;
          }
        }
        if (total > 10) text += `\n_...and ${total - 10} more. Use get_type for the full list._\n`;
      }
      return { content: [{ type: "text", text }], isError: true };
    }

    let text = `# ${typeEntry.name}.${member.name}\n`;
    text += `**Kind:** ${member.kind}\n`;
    text += `**Type:** ${typeEntry.namespace}.${typeEntry.name}\n`;
    text += `**URL:** ${typeEntry.url}\n\n`;
    if (member.summary) text += `${member.summary}\n\n`;
    if (member.declaration) text += `\`\`\`csharp\n${member.declaration}\n\`\`\`\n`;
    return { content: [{ type: "text", text }] };
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
