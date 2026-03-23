import type { DalamudCache, TypeEntry } from "./crawler.js";

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
  limit = 20
): SearchResult[] {
  const clampedLimit = Math.min(Math.max(1, Math.floor(limit)), 100);
  const q = query.toLowerCase().trim();
  if (!q) return [];

  const results: SearchResult[] = [];

  for (const ns of cache.namespaces) {
    for (const type of ns.types) {
      const name = type.name.toLowerCase();
      const summary = type.summary.toLowerCase();
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
          if (m.name.toLowerCase().includes(q) || m.summary.toLowerCase().includes(q)) {
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

/** Find a namespace by exact name. Case-insensitive. */
export function findNamespace(cache: DalamudCache, name: string) {
  const q = name.toLowerCase().trim();
  return cache.namespaces.find((ns) => ns.name.toLowerCase() === q);
}
