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
  type TypeKind,
} from "./crawler.js";
import { findNamespace, findType, search, searchMembers, isEventRelated } from "./search.js";
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
          kind: {
            type: "string",
            enum: ["class", "interface", "enum", "struct", "delegate", "record", "unknown"],
            description: "Filter results to a specific type kind",
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
    {
      name: "list_services",
      description:
        "List all DI-injectable services from Dalamud.Plugin.Services — the primary namespace for plugin authors. Returns interfaces only by default; pass includeDelegate: true to also show event-delegate types.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Optional substring filter on name and summary (case-insensitive)" },
          includeDelegate: { type: "boolean", description: "When true, include delegate types alongside interfaces. Default: false." },
        },
      },
    },
    {
      name: "find_events",
      description:
        "Find event-related types and delegate subscription points across the Dalamud API. Useful for locating EventArgs classes, event enums, and delegate types used to subscribe to framework events.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Optional substring filter on name and summary (case-insensitive)" },
          kind: {
            type: "string",
            enum: ["type", "delegate", "all"],
            description: '"type" = event arg classes/enums/interfaces; "delegate" = delegate subscription types; "all" = both. Default: "all".',
          },
        },
      },
    },
    {
      name: "list_enums",
      description:
        "List all enum types in the Dalamud API, optionally filtered by namespace or keyword. Useful for discovering game-state constants (job IDs, inventory slots, addon names, etc.).",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Optional substring filter on enum name and summary (case-insensitive)" },
          namespace: { type: "string", description: 'Restrict to an exact namespace, e.g. "Dalamud.Game.ClientState.JobGauge"' },
          limit: { type: "number", description: "Maximum number of results (default: 50, max: 200)" },
        },
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
      const suggestions = search(cache, typeName, { limit: 5 });
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
    const TYPE_KINDS: TypeKind[] = ["class", "interface", "enum", "struct", "delegate", "record", "unknown"];
    const rawKind = (args as any)?.kind;
    if (rawKind !== undefined && !TYPE_KINDS.includes(rawKind)) {
      return { content: [{ type: "text", text: `Invalid kind "${rawKind}". Must be one of: ${TYPE_KINDS.join(", ")}` }], isError: true };
    }
    const kind = rawKind as TypeKind | undefined;
    const rawLimit = (args as any)?.limit;
    const limit = Number.isFinite(rawLimit) ? rawLimit : 20;
    const results = search(cache, query, { limit, kind });

    if (results.length === 0) {
      const kindSuffix = kind ? ` of kind "${kind}"` : "";
      return {
        content: [{ type: "text", text: `No results found for "${query}"${kindSuffix}.` }],
      };
    }

    let text = `# Search results for "${query}" (${results.length} found)\n`;
    if (kind) text += `Filtered by kind: ${kind}\n`;
    text += "\n";
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
      const suggestions = search(cache, typeName, { limit: 5 });
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

  if (name === "list_services") {
    const query = typeof (args as any)?.query === "string" ? (args as any).query.trim() : null;
    const includeDelegate = (args as any)?.includeDelegate === true;

    const ns = findNamespace(cache, "Dalamud.Plugin.Services");
    if (!ns) {
      return { content: [{ type: "text", text: "Dalamud.Plugin.Services not found in cache. Try refresh_cache." }], isError: true };
    }

    let types = ns.types.filter(
      (t) => t.kind === "interface" || (includeDelegate && t.kind === "delegate")
    );

    if (query) {
      const q = query.toLowerCase();
      types = types.filter(
        (t) => t.name.toLowerCase().includes(q) || (t.summary ?? "").toLowerCase().includes(q)
      );
    }

    types.sort((a, b) => a.name.localeCompare(b.name));

    if (types.length === 0) {
      return { content: [{ type: "text", text: query ? `No services matching "${query}" found.` : "No services found." }] };
    }

    let text = `# Dalamud.Plugin.Services — Services (${types.length})\n\n`;
    if (query) text += `Filtered by: "${query}"\n\n`;
    for (const t of types) {
      text += `### ${t.name}`;
      if (t.kind === "delegate") text += ` _(delegate)_`;
      text += `\n`;
      if (t.summary) text += `${t.summary}\n`;
      text += `URL: ${t.url}\n\n`;
    }
    return { content: [{ type: "text", text }] };
  }

  if (name === "find_events") {
    const query = typeof (args as any)?.query === "string" ? (args as any).query.trim() : null;
    const rawKind = (args as any)?.kind;
    const kindFilter: "type" | "delegate" | "all" =
      ["type", "delegate", "all"].includes(rawKind) ? rawKind : "all";

    type EventMatch = { ns: string; entry: typeof cache.namespaces[0]["types"][0] };
    const matches: EventMatch[] = [];

    for (const ns of cache.namespaces) {
      for (const t of ns.types) {
        if (!isEventRelated(t)) continue;
        if (kindFilter === "type" && t.kind === "delegate") continue;
        if (kindFilter === "delegate" && t.kind !== "delegate") continue;
        if (query) {
          const q = query.toLowerCase();
          if (!t.name.toLowerCase().includes(q) && !(t.summary ?? "").toLowerCase().includes(q)) continue;
        }
        matches.push({ ns: t.namespace, entry: t });
      }
    }

    if (matches.length === 0) {
      return { content: [{ type: "text", text: query ? `No event-related types matching "${query}" found.` : "No event-related types found in cache." }] };
    }

    // Group by namespace
    const byNs = new Map<string, typeof matches[0]["entry"][]>();
    for (const m of matches) {
      if (!byNs.has(m.ns)) byNs.set(m.ns, []);
      byNs.get(m.ns)!.push(m.entry);
    }
    const sortedNs = [...byNs.keys()].sort();

    let text = `# Event-related types (${matches.length})\n`;
    if (query) text += `Filtered by: "${query}"\n`;
    if (kindFilter !== "all") text += `Kind: ${kindFilter}\n`;
    text += "\n";

    for (const nsName of sortedNs) {
      text += `## ${nsName}\n\n`;
      const nsTypes = byNs.get(nsName)!.sort((a, b) => a.name.localeCompare(b.name));
      for (const t of nsTypes) {
        text += `### ${t.name} _(${t.kind})_\n`;
        if (t.summary) text += `${t.summary}\n`;
        text += `URL: ${t.url}\n\n`;
      }
    }
    return { content: [{ type: "text", text }] };
  }

  if (name === "list_enums") {
    const query = typeof (args as any)?.query === "string" ? (args as any).query.trim() : null;
    const nsFilter = typeof (args as any)?.namespace === "string" ? (args as any).namespace.toLowerCase().trim() : null;
    const rawLimit = (args as any)?.limit;
    const clampedLimit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, Math.floor(rawLimit)), 200) : 50;

    const q = query ? query.toLowerCase() : null;
    const byNs = new Map<string, typeof cache.namespaces[0]["types"]>();

    for (const ns of cache.namespaces) {
      if (nsFilter && ns.name.toLowerCase() !== nsFilter) continue;

      for (const t of ns.types) {
        if (t.kind !== "enum") continue;
        if (q && !t.name.toLowerCase().includes(q) && !(t.summary ?? "").toLowerCase().includes(q)) continue;

        if (!byNs.has(t.namespace)) byNs.set(t.namespace, []);
        byNs.get(t.namespace)!.push(t);
      }
    }

    const total = [...byNs.values()].reduce((a, ts) => a + ts.length, 0);

    if (total === 0) {
      const parts: string[] = [];
      if (query) parts.push(`matching "${query}"`);
      if (nsFilter) parts.push(`in namespace "${(args as any).namespace}"`);
      return { content: [{ type: "text", text: `No enums found${parts.length ? " " + parts.join(" ") : ""}.` }] };
    }

    const sortedNs = [...byNs.keys()].sort();
    let emitted = 0;

    let text = `# Dalamud API Enums (${total} total)\n`;
    if (query) text += `Filtered by: "${query}"\n`;
    if (nsFilter) text += `Namespace: ${(args as any).namespace}\n`;
    text += "\n";

    outer: for (const nsName of sortedNs) {
      const types = byNs.get(nsName)!.sort((a, b) => a.name.localeCompare(b.name));
      text += `## ${nsName}\n\n`;
      for (const t of types) {
        if (emitted >= clampedLimit) {
          text += `_...and ${total - emitted} more. Use a narrower query or namespace filter to see more._\n`;
          break outer;
        }
        text += `### ${t.name}\n`;
        if (t.summary) text += `${t.summary}\n`;
        text += `URL: ${t.url}\n\n`;
        emitted++;
      }
    }

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
