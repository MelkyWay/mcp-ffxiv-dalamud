import { describe, it, expect } from "vitest";
import { search, findType, findNamespace } from "../search.js";
import type { DalamudCache } from "../crawler.js";

const fakeCache: DalamudCache = {
  cacheVersion: 2,
  builtAt: "2026-01-01T00:00:00Z",
  namespaces: [
    {
      name: "Dalamud.Plugin.Services",
      url: "https://dalamud.dev/api/Dalamud.Plugin.Services/",
      types: [
        {
          name: "IClientState",
          kind: "interface",
          namespace: "Dalamud.Plugin.Services",
          url: "https://dalamud.dev/api/Dalamud.Plugin.Services/Interfaces/IClientState",
          summary: "Provides access to the current state of the game client.",
          membersLoaded: false,
        },
        {
          name: "ICommandManager",
          kind: "interface",
          namespace: "Dalamud.Plugin.Services",
          url: "https://dalamud.dev/api/Dalamud.Plugin.Services/Interfaces/ICommandManager",
          summary: "Allows registration of in-game slash commands.",
          membersLoaded: false,
        },
      ],
    },
    {
      name: "Dalamud.Game",
      url: "https://dalamud.dev/api/Dalamud.Game/",
      types: [
        {
          name: "Framework",
          kind: "class",
          namespace: "Dalamud.Game",
          url: "https://dalamud.dev/api/Dalamud.Game/Classes/Framework",
          summary: "Provides access to the game framework tick.",
          membersLoaded: false,
        },
      ],
    },
  ],
};

// ── findType ────────────────────────────────────────────────────────────────

describe("findType", () => {
  it("finds by exact simple name (case-insensitive)", () => {
    expect(findType(fakeCache, "IClientState")?.name).toBe("IClientState");
    expect(findType(fakeCache, "iclientstate")?.name).toBe("IClientState");
    expect(findType(fakeCache, "ICLIENTSTATE")?.name).toBe("IClientState");
  });

  it("finds by namespace-qualified name", () => {
    const result = findType(fakeCache, "Dalamud.Plugin.Services.IClientState");
    expect(result?.name).toBe("IClientState");
  });

  it("finds by namespace-qualified name case-insensitively", () => {
    const result = findType(fakeCache, "dalamud.plugin.services.iclientstate");
    expect(result?.name).toBe("IClientState");
  });

  it("returns undefined for unknown type", () => {
    expect(findType(fakeCache, "NonExistent")).toBeUndefined();
  });

  it("does not match partial names", () => {
    expect(findType(fakeCache, "Client")).toBeUndefined();
  });

  it("handles U+200B zero-width spaces in query gracefully", () => {
    // Query with ZWS should not match a clean cache entry
    expect(findType(fakeCache, "IClientState\u200b")).toBeUndefined();
  });
});

// ── findNamespace ────────────────────────────────────────────────────────────

describe("findNamespace", () => {
  it("finds by exact name", () => {
    expect(findNamespace(fakeCache, "Dalamud.Plugin.Services")?.name).toBe("Dalamud.Plugin.Services");
  });

  it("finds case-insensitively", () => {
    expect(findNamespace(fakeCache, "dalamud.plugin.services")?.name).toBe("Dalamud.Plugin.Services");
  });

  it("returns undefined for unknown namespace", () => {
    expect(findNamespace(fakeCache, "Dalamud.Nonexistent")).toBeUndefined();
  });
});

// ── search ──────────────────────────────────────────────────────────────────

describe("search", () => {
  it("returns empty array for empty query", () => {
    expect(search(fakeCache, "")).toHaveLength(0);
    expect(search(fakeCache, "   ")).toHaveLength(0);
  });

  it("returns empty array when nothing matches", () => {
    expect(search(fakeCache, "zzznomatch")).toHaveLength(0);
  });

  it("scores exact name match highest", () => {
    const results = search(fakeCache, "IClientState");
    expect(results[0].type.name).toBe("IClientState");
    expect(results[0].score).toBe(1000);
  });

  it("scores name-starts-with above name-contains", () => {
    const results = search(fakeCache, "IClient");
    const topScore = results[0].score;
    expect(topScore).toBe(500);
  });

  it("matches on summary text", () => {
    const results = search(fakeCache, "slash commands");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].type.name).toBe("ICommandManager");
  });

  it("matches on namespace-qualified name", () => {
    const results = search(fakeCache, "Dalamud.Game.Framework");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].type.name).toBe("Framework");
  });

  it("results are sorted by descending score", () => {
    const results = search(fakeCache, "command");
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it("clamps limit to max 100", () => {
    const results = search(fakeCache, "a", 99999);
    expect(results.length).toBeLessThanOrEqual(100);
  });

  it("clamps negative limit to 1", () => {
    const results = search(fakeCache, "IClientState", -5);
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it("clamps zero limit to 1", () => {
    const results = search(fakeCache, "IClientState", 0);
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it("respects reasonable limit", () => {
    const results = search(fakeCache, "i", 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("treats NaN limit as default (clamps to 1)", () => {
    const results = search(fakeCache, "IClientState", NaN);
    // NaN → Math.floor(NaN) = NaN → Math.max(1, NaN) = 1
    expect(results.length).toBeGreaterThanOrEqual(0);
  });

  it("treats Infinity limit as max 100", () => {
    const results = search(fakeCache, "i", Infinity);
    expect(results.length).toBeLessThanOrEqual(100);
  });

  it("searches loaded member names and summaries", () => {
    const cacheWithMembers: DalamudCache = {
      ...fakeCache,
      namespaces: [
        {
          ...fakeCache.namespaces[0],
          types: [
            {
              ...fakeCache.namespaces[0].types[0],
              membersLoaded: true,
              members: [
                { name: "LocalPlayer", kind: "property", declaration: "", summary: "The local player character." },
              ],
            },
          ],
        },
      ],
    };
    const results = search(cacheWithMembers, "LocalPlayer");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].type.name).toBe("IClientState");
  });
});
