import { describe, it, expect } from "vitest";
import { search, findType, findNamespace, searchMembers } from "../search.js";
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

  it("treats NaN limit as default of 20, returning results normally", () => {
    const results = search(fakeCache, "IClientState", NaN);
    expect(results.length).toBe(1);
    expect(results[0].type.name).toBe("IClientState");
  });

  it("treats Infinity limit as max 100", () => {
    const results = search(fakeCache, "i", Infinity);
    expect(results.length).toBeLessThanOrEqual(100);
  });

  it("does not crash when type summary is missing", () => {
    const cacheNoSummary: DalamudCache = {
      ...fakeCache,
      namespaces: [
        {
          ...fakeCache.namespaces[0],
          types: [{ ...fakeCache.namespaces[0].types[0], summary: undefined as any }],
        },
      ],
    };
    expect(() => search(cacheNoSummary, "client")).not.toThrow();
  });

  it("does not crash when member summary is missing", () => {
    const cacheNoMemberSummary: DalamudCache = {
      ...fakeCache,
      namespaces: [
        {
          ...fakeCache.namespaces[0],
          types: [
            {
              ...fakeCache.namespaces[0].types[0],
              membersLoaded: true,
              members: [{ name: "LocalPlayer", kind: "property", declaration: "", summary: undefined as any }],
            },
          ],
        },
      ],
    };
    expect(() => search(cacheNoMemberSummary, "LocalPlayer")).not.toThrow();
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

// ── searchMembers ─────────────────────────────────────────────────────────────

const cacheWithLoadedMembers: DalamudCache = {
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
          membersLoaded: true,
          members: [
            { name: "LocalPlayer", kind: "property", declaration: "PlayerCharacter? LocalPlayer { get; }", summary: "The local player character." },
            { name: "IsLoggedIn", kind: "property", declaration: "bool IsLoggedIn { get; }", summary: "Whether the player is logged in." },
            { name: "GetPartyMembers", kind: "method", declaration: "IEnumerable<PartyMember> GetPartyMembers()", summary: "Returns all current party members." },
          ],
        },
        {
          name: "ICommandManager",
          kind: "interface",
          namespace: "Dalamud.Plugin.Services",
          url: "https://dalamud.dev/api/Dalamud.Plugin.Services/Interfaces/ICommandManager",
          summary: "Manages slash commands.",
          membersLoaded: false,
          members: undefined,
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
          summary: "Game framework tick.",
          membersLoaded: true,
          members: [
            { name: "Update", kind: "event", declaration: "event Action<Framework> Update;", summary: "Fires on each framework tick." },
            { name: "LocalPlayer", kind: "property", declaration: "PlayerCharacter? LocalPlayer { get; }", summary: "Framework-level player reference." },
          ],
        },
        {
          name: "GameNetwork",
          kind: "class",
          namespace: "Dalamud.Game",
          url: "https://dalamud.dev/api/Dalamud.Game/Classes/GameNetwork",
          summary: "Network access.",
          membersLoaded: true,
          members: [],
        },
      ],
    },
  ],
};

describe("searchMembers", () => {
  it("returns [] for empty query", () => {
    expect(searchMembers(cacheWithLoadedMembers, "")).toEqual([]);
  });

  it("returns [] for whitespace query", () => {
    expect(searchMembers(cacheWithLoadedMembers, "   ")).toEqual([]);
  });

  it("returns [] when nothing matches", () => {
    expect(searchMembers(cacheWithLoadedMembers, "zzznomatch")).toEqual([]);
  });

  it("skips types with membersLoaded false", () => {
    const results = searchMembers(cacheWithLoadedMembers, "AddHandler");
    expect(results.length).toBe(0);
  });

  it("does not crash on type with empty members array", () => {
    const results = searchMembers(cacheWithLoadedMembers, "anything");
    expect(Array.isArray(results)).toBe(true);
  });

  it("exact name match scores 1000", () => {
    const results = searchMembers(cacheWithLoadedMembers, "IsLoggedIn");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].score).toBe(1000);
    expect(results[0].member.name).toBe("IsLoggedIn");
  });

  it("name starts-with scores 500", () => {
    const results = searchMembers(cacheWithLoadedMembers, "IsLog");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].score).toBe(500);
  });

  it("name contains scores 200", () => {
    const results = searchMembers(cacheWithLoadedMembers, "artyM");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].score).toBe(200);
  });

  it("summary-only match scores 50", () => {
    const results = searchMembers(cacheWithLoadedMembers, "framework tick");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].score).toBe(50);
    expect(results[0].member.name).toBe("Update");
  });

  it("kind filter excludes non-matching kinds", () => {
    const results = searchMembers(cacheWithLoadedMembers, "LocalPlayer", { kind: "method" });
    expect(results.length).toBe(0);
  });

  it("kind filter passes matching kinds", () => {
    const results = searchMembers(cacheWithLoadedMembers, "LocalPlayer", { kind: "property" });
    expect(results.length).toBeGreaterThan(0);
    results.forEach((r) => expect(r.member.kind).toBe("property"));
  });

  it("namespace filter restricts to that namespace", () => {
    const results = searchMembers(cacheWithLoadedMembers, "LocalPlayer", { namespace: "Dalamud.Game" });
    expect(results.length).toBe(1);
    expect(results[0].ownerName).toBe("Framework");
  });

  it("namespace filter returns [] for unknown namespace", () => {
    const results = searchMembers(cacheWithLoadedMembers, "LocalPlayer", { namespace: "Dalamud.Nonexistent" });
    expect(results.length).toBe(0);
  });

  it("sorts by score descending", () => {
    const results = searchMembers(cacheWithLoadedMembers, "local");
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it("tie-breaks by ownerName ascending", () => {
    const results = searchMembers(cacheWithLoadedMembers, "LocalPlayer", { kind: "property" });
    const names = results.map((r) => r.ownerName);
    expect(names[0]).toBe("Framework");
    expect(names[1]).toBe("IClientState");
  });

  it("respects limit", () => {
    const results = searchMembers(cacheWithLoadedMembers, "local", { limit: 1 });
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it("clamps limit to minimum 1", () => {
    const results = searchMembers(cacheWithLoadedMembers, "local", { limit: -99 });
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it("clamps limit to maximum 50", () => {
    const results = searchMembers(cacheWithLoadedMembers, "l", { limit: 9999 });
    expect(results.length).toBeLessThanOrEqual(50);
  });

  it("NaN limit defaults to 20", () => {
    const results = searchMembers(cacheWithLoadedMembers, "local", { limit: NaN });
    expect(results.length).toBeGreaterThanOrEqual(0);
    expect(results.length).toBeLessThanOrEqual(20);
  });

  it("result contains all expected fields", () => {
    const results = searchMembers(cacheWithLoadedMembers, "LocalPlayer", { kind: "property" });
    const r = results[0];
    expect(typeof r.member.name).toBe("string");
    expect(typeof r.ownerName).toBe("string");
    expect(typeof r.ownerNamespace).toBe("string");
    expect(typeof r.ownerUrl).toBe("string");
    expect(typeof r.score).toBe("number");
  });

  it("does not crash when member summary is undefined", () => {
    const cache: DalamudCache = {
      cacheVersion: 2,
      builtAt: "2026-01-01T00:00:00Z",
      namespaces: [{
        name: "Test", url: "https://dalamud.dev/api/Test/",
        types: [{
          name: "Foo", kind: "class", namespace: "Test",
          url: "https://dalamud.dev/api/Test/Classes/Foo",
          summary: "", membersLoaded: true,
          members: [{ name: "Bar", kind: "property", declaration: "", summary: undefined as any }],
        }],
      }],
    };
    expect(() => searchMembers(cache, "Bar")).not.toThrow();
  });
});
