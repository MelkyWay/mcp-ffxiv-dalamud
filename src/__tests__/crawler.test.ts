import { describe, it, expect } from "vitest";
import { normalizeKind, isValidCache } from "../crawler.js";

// ── normalizeKind ────────────────────────────────────────────────────────────

describe("normalizeKind", () => {
  it.each([
    ["Interface", "interface"],
    ["interface", "interface"],
    ["INTERFACE", "interface"],
    ["Enum", "enum"],
    ["Struct", "struct"],
    ["Delegate", "delegate"],
    ["Record", "record"],
    ["Class", "class"],
    ["abstract class", "class"],
    ["sealed class", "class"],
    ["something unknown", "unknown"],
    ["", "unknown"],
  ])("normalizeKind(%s) → %s", (input, expected) => {
    expect(normalizeKind(input)).toBe(expected);
  });
});

// ── isValidCache ─────────────────────────────────────────────────────────────

describe("isValidCache", () => {
  const valid = {
    cacheVersion: 2,
    builtAt: "2026-01-01T00:00:00Z",
    namespaces: [],
  };

  it("accepts a valid cache object", () => {
    expect(isValidCache(valid)).toBe(true);
  });

  it("accepts cache with optional dalamudVersion", () => {
    expect(isValidCache({ ...valid, dalamudVersion: "v10.0.0" })).toBe(true);
  });

  it("rejects null", () => {
    expect(isValidCache(null)).toBe(false);
  });

  it("rejects non-object", () => {
    expect(isValidCache("string")).toBe(false);
    expect(isValidCache(42)).toBe(false);
    expect(isValidCache([])).toBe(false);
  });

  it("rejects missing cacheVersion", () => {
    const { cacheVersion: _, ...rest } = valid;
    expect(isValidCache(rest)).toBe(false);
  });

  it("rejects wrong cacheVersion (old cache before fix)", () => {
    expect(isValidCache({ ...valid, cacheVersion: 1 })).toBe(false);
    expect(isValidCache({ ...valid, cacheVersion: 0 })).toBe(false);
  });

  it("rejects missing builtAt", () => {
    const { builtAt: _, ...rest } = valid;
    expect(isValidCache(rest)).toBe(false);
  });

  it("rejects non-string builtAt", () => {
    expect(isValidCache({ ...valid, builtAt: 12345 })).toBe(false);
  });

  it("rejects missing namespaces", () => {
    const { namespaces: _, ...rest } = valid;
    expect(isValidCache(rest)).toBe(false);
  });

  it("rejects non-array namespaces", () => {
    expect(isValidCache({ ...valid, namespaces: {} })).toBe(false);
    expect(isValidCache({ ...valid, namespaces: null })).toBe(false);
  });

  it("rejects empty object", () => {
    expect(isValidCache({})).toBe(false);
  });

  // Nested shape validation (added after review finding #1)
  const validNs = { name: "Dalamud.Game", url: "https://dalamud.dev/api/Dalamud.Game/", types: [] };
  const validType = { name: "Framework", namespace: "Dalamud.Game", url: "https://dalamud.dev/..." };

  it("accepts a cache with well-formed namespaces and types", () => {
    expect(isValidCache({ ...valid, namespaces: [{ ...validNs, types: [validType] }] })).toBe(true);
  });

  it("rejects namespaces containing null", () => {
    expect(isValidCache({ ...valid, namespaces: [null] })).toBe(false);
  });

  it("rejects namespace missing name", () => {
    const { name: _, ...rest } = validNs;
    expect(isValidCache({ ...valid, namespaces: [rest] })).toBe(false);
  });

  it("rejects namespace missing url", () => {
    const { url: _, ...rest } = validNs;
    expect(isValidCache({ ...valid, namespaces: [rest] })).toBe(false);
  });

  it("rejects namespace with non-array types", () => {
    expect(isValidCache({ ...valid, namespaces: [{ ...validNs, types: null }] })).toBe(false);
  });

  it("rejects type missing name", () => {
    const { name: _, ...rest } = validType;
    expect(isValidCache({ ...valid, namespaces: [{ ...validNs, types: [rest] }] })).toBe(false);
  });

  it("rejects type missing namespace", () => {
    const { namespace: _, ...rest } = validType;
    expect(isValidCache({ ...valid, namespaces: [{ ...validNs, types: [rest] }] })).toBe(false);
  });

  it("rejects type missing url", () => {
    const { url: _, ...rest } = validType;
    expect(isValidCache({ ...valid, namespaces: [{ ...validNs, types: [rest] }] })).toBe(false);
  });
});
