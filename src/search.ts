import type { DalamudCache, TypeEntry, Member, TypeKind } from "./crawler.js";

export interface SearchResult {
  score: number;
  type: TypeEntry;
}

/**
 * Simple full-text search over type names and summaries.
 * Scores: exact name match > name starts with > name contains > summary contains
 */
export function search(
  cache: DalamudCache,
  query: string,
  options?: { limit?: number; kind?: TypeKind }
): SearchResult[] {
  const { limit, kind } = options ?? {};
  const clampedLimit = Number.isFinite(limit) ? Math.min(Math.max(1, Math.floor(limit!)), 100) : 20;
  const q = query.toLowerCase().trim();
  if (!q) return [];

  const results: SearchResult[] = [];

  for (const ns of cache.namespaces) {
    for (const type of ns.types) {
      if (kind && type.kind !== kind) continue;

      const name = type.name.toLowerCase();
      const summary = (type.summary ?? "").toLowerCase();
      const fullName = `${type.namespace}.${type.name}`.toLowerCase();

      let score = 0;

      if (name === q || fullName === q) {
        score = 1000;
      } else if (name.startsWith(q)) {
        score = 500;
      } else if (name.includes(q)) {
        score = 200;
      } else if (fullName.includes(q)) {
        score = 150;
      } else if (summary.includes(q)) {
        score = 50;
      }

      // Bonus: if member names match and members are loaded
      if (score === 0 && type.members) {
        for (const m of type.members) {
          if ((m.name ?? "").toLowerCase().includes(q) || (m.summary ?? "").toLowerCase().includes(q)) {
            score = 25;
            break;
          }
        }
      }

      if (score > 0) {
        results.push({ score, type });
      }
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, clampedLimit);
}

/** Find a type by exact name or namespace-qualified name. Case-insensitive. */
export function findType(
  cache: DalamudCache,
  name: string
): TypeEntry | undefined {
  const q = name.toLowerCase().trim();

  // Try exact match on simple name first
  for (const ns of cache.namespaces) {
    for (const type of ns.types) {
      if (type.name.toLowerCase() === q) return type;
    }
  }

  // Try namespace-qualified match
  for (const ns of cache.namespaces) {
    for (const type of ns.types) {
      if (`${type.namespace}.${type.name}`.toLowerCase() === q) return type;
    }
  }

  return undefined;
}

export interface MemberSearchResult {
  score: number;
  member: Member;
  ownerName: string;
  ownerNamespace: string;
  ownerUrl: string;
}

/** Search members across all loaded types. No HTTP — works on already-loaded members only. */
export function searchMembers(
  cache: DalamudCache,
  query: string,
  options?: { kind?: Member["kind"]; namespace?: string; limit?: number }
): MemberSearchResult[] {
  const { kind, namespace, limit } = options ?? {};
  const clampedLimit = Number.isFinite(limit) ? Math.min(Math.max(1, Math.floor(limit!)), 50) : 20;
  const q = query.toLowerCase().trim();
  if (!q) return [];

  const nsFilter = namespace?.toLowerCase().trim() ?? null;
  const results: MemberSearchResult[] = [];

  for (const ns of cache.namespaces) {
    if (nsFilter && ns.name.toLowerCase() !== nsFilter) continue;

    for (const type of ns.types) {
      if (!type.membersLoaded) continue;

      for (const member of type.members ?? []) {
        if (kind && member.kind !== kind) continue;

        const name = (member.name ?? "").toLowerCase();
        const summary = (member.summary ?? "").toLowerCase();

        let score = 0;
        if (name === q) score = 1000;
        else if (name.startsWith(q)) score = 500;
        else if (name.includes(q)) score = 200;
        else if (summary.includes(q)) score = 50;

        if (score > 0) {
          results.push({ score, member, ownerName: type.name, ownerNamespace: type.namespace, ownerUrl: type.url });
        }
      }
    }
  }

  results.sort((a, b) => b.score - a.score || a.ownerName.localeCompare(b.ownerName));
  return results.slice(0, clampedLimit);
}

/** Returns true if a type is event-related (delegate, event arg, or event enum). */
export function isEventRelated(type: TypeEntry): boolean {
  const name = type.name.toLowerCase();
  const summary = (type.summary ?? "").toLowerCase();
  if (type.kind === "delegate") return true;
  if (name.includes("event")) return true;
  if (summary.includes("event")) return true;
  return false;
}

/** Find a namespace by exact name. Case-insensitive. */
export function findNamespace(cache: DalamudCache, name: string) {
  const q = name.toLowerCase().trim();
  return cache.namespaces.find((ns) => ns.name.toLowerCase() === q);
}
