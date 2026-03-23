import * as cheerio from "cheerio";
import * as fs from "fs";
import fetch from "node-fetch";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_URL = "https://dalamud.dev";
const API_URL = `${BASE_URL}/api/`;
const CACHE_PATH = path.join(__dirname, "..", "cache", "dalamud-api.json");

export type TypeKind =
  | "class"
  | "interface"
  | "enum"
  | "struct"
  | "delegate"
  | "record"
  | "unknown";

export interface Member {
  name: string;
  kind: "property" | "method" | "field" | "event" | "constructor" | "unknown";
  declaration: string;
  summary: string;
}

export interface TypeEntry {
  name: string;
  kind: TypeKind;
  namespace: string;
  url: string;
  summary: string;
  members?: Member[];
  membersLoaded?: boolean;
}

export interface Namespace {
  name: string;
  url: string;
  types: TypeEntry[];
}

const CACHE_VERSION = 2;

export interface DalamudCache {
  cacheVersion: number;
  builtAt: string;
  dalamudVersion?: string;
  namespaces: Namespace[];
}

const GITHUB_RELEASES_URL =
  "https://api.github.com/repos/goatcorp/Dalamud/releases/latest";

export async function fetchLatestDalamudTag(): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(GITHUB_RELEASES_URL, {
      headers: { "User-Agent": "mcp-dalamud/1.0" },
      signal: controller.signal,
    });
    if (!response.ok) {
      process.stderr.write(
        `[dalamud-mcp] GitHub API returned ${response.status}, skipping update check\n`
      );
      return null;
    }
    const json = (await response.json()) as { tag_name?: string };
    return json.tag_name ?? null;
  } catch (e) {
    process.stderr.write(
      `[dalamud-mcp] GitHub unreachable, skipping update check: ${e}\n`
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchHtml(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);
    return response.text();
  } finally {
    clearTimeout(timer);
  }
}

function getMainContent($: cheerio.CheerioAPI): ReturnType<cheerio.CheerioAPI> {
  // Docusaurus wraps article content in various selectors
  const selectors = [
    "article",
    "main .container",
    ".theme-doc-markdown",
    "main",
  ];
  for (const sel of selectors) {
    const el = $(sel);
    if (el.length > 0) return el.first();
  }
  return $("body");
}

export function normalizeKind(text: string): TypeKind {
  const lower = text.toLowerCase();
  if (lower.includes("interface")) return "interface";
  if (lower.includes("enum")) return "enum";
  if (lower.includes("struct")) return "struct";
  if (lower.includes("delegate")) return "delegate";
  if (lower.includes("record")) return "record";
  if (lower.includes("class")) return "class";
  return "unknown";
}

/** Phase 1: Get all namespace names and URLs from /api/ */
export async function crawlNamespaceIndex(): Promise<
  Pick<Namespace, "name" | "url">[]
> {
  const html = await fetchHtml(API_URL);
  const $ = cheerio.load(html);
  const namespaces: Pick<Namespace, "name" | "url">[] = [];

  // Namespace links follow the pattern: /api/Some.Namespace/
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    const text = $(el).text().trim();
    // Match /api/Dalamud... paths (not deeper type pages)
    if (
      href.match(/^\/api\/Dalamud[\w.]+\/$/) &&
      text.startsWith("Dalamud")
    ) {
      const url = `${BASE_URL}${href}`;
      if (!namespaces.find((n) => n.name === text)) {
        namespaces.push({ name: text, url });
      }
    }
  });

  return namespaces;
}

/** Phase 2: Get all types from a namespace page */
export async function crawlNamespacePage(
  ns: Pick<Namespace, "name" | "url">
): Promise<TypeEntry[]> {
  const html = await fetchHtml(ns.url);
  const $ = cheerio.load(html);
  const content = getMainContent($);
  const types: TypeEntry[] = [];

  let currentKind: TypeKind = "unknown";

  content.find("h2, h3").each((_, el) => {
    const tag = el.tagName.toLowerCase();
    const text = $(el).text().trim();

    if (tag === "h2") {
      currentKind = normalizeKind(text);
      return;
    }

    if (tag === "h3") {
      const link = $(el).find("a[href]");
      const typeName = (link.length ? link.text() : text).replace(/\u200b/g, "").trim();
      const href = link.attr("href") || "";

      // Summary is the next sibling paragraph
      const summary = $(el).next("p").text().trim();

      // Build absolute URL
      let typeUrl = href;
      if (href.startsWith("/")) {
        typeUrl = `${BASE_URL}${href}`;
      } else if (!href.startsWith("http")) {
        typeUrl = ns.url + href;
      }

      if (typeName) {
        types.push({
          name: typeName,
          kind: currentKind,
          namespace: ns.name,
          url: typeUrl,
          summary,
          membersLoaded: false,
        });
      }
    }
  });

  return types;
}

function parseMemberKind(
  sectionHeader: string
): Member["kind"] {
  const lower = sectionHeader.toLowerCase();
  if (lower.includes("propert")) return "property";
  if (lower.includes("method")) return "method";
  if (lower.includes("field")) return "field";
  if (lower.includes("event")) return "event";
  if (lower.includes("constructor")) return "constructor";
  return "unknown";
}

/** Phase 3 (lazy): Get members from a type page */
export async function crawlTypePage(typeEntry: TypeEntry): Promise<Member[]> {
  if (!typeEntry.url) return [];

  const html = await fetchHtml(typeEntry.url);
  const $ = cheerio.load(html);
  const content = getMainContent($);
  const members: Member[] = [];

  let currentMemberKind: Member["kind"] = "unknown";

  content.find("h2, h3, h6, pre, code").each((_, el) => {
    const tag = el.tagName.toLowerCase();
    const text = $(el).text().trim();

    if (tag === "h2") {
      currentMemberKind = parseMemberKind(text);
      return;
    }

    if (tag === "h3") {
      const name = $(el).text().trim();
      if (!name || name.length === 0) return;

      // Summary = next paragraph before an h6
      let summary = "";
      let declaration = "";
      let sibling = $(el).next();

      while (sibling.length && !["h2", "h3"].includes(sibling.prop("tagName")?.toLowerCase() ?? "")) {
        const sibTag = sibling.prop("tagName")?.toLowerCase();
        const sibText = sibling.text().trim();

        if (sibTag === "p" && !summary) {
          summary = sibText;
        } else if (sibTag === "h6" && sibText === "Declaration") {
          // The declaration code block follows
          const codeBlock = sibling.next();
          if (codeBlock.length) {
            declaration = codeBlock.find("code").text().trim() || codeBlock.text().trim();
          }
        }
        sibling = sibling.next();
      }

      if (name && currentMemberKind !== "unknown") {
        members.push({
          name,
          kind: currentMemberKind,
          declaration,
          summary,
        });
      }
    }
  });

  return members;
}

function isValidNamespace(ns: unknown): boolean {
  if (typeof ns !== "object" || ns === null) return false;
  const n = ns as any;
  if (typeof n.name !== "string" || typeof n.url !== "string") return false;
  if (!Array.isArray(n.types)) return false;
  return n.types.every(
    (t: unknown) =>
      typeof t === "object" &&
      t !== null &&
      typeof (t as any).name === "string" &&
      typeof (t as any).namespace === "string" &&
      typeof (t as any).url === "string"
  );
}

export function isValidCache(parsed: unknown): parsed is DalamudCache {
  if (typeof parsed !== "object" || parsed === null) return false;
  const p = parsed as any;
  return (
    p.cacheVersion === CACHE_VERSION &&
    typeof p.builtAt === "string" &&
    Array.isArray(p.namespaces) &&
    p.namespaces.every(isValidNamespace)
  );
}

export function loadCache(): DalamudCache | null {
  if (!fs.existsSync(CACHE_PATH)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(CACHE_PATH, "utf-8"));
    if (!isValidCache(parsed)) {
      process.stderr.write("[dalamud-mcp] Cache invalid or outdated, discarding.\n");
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveCache(cache: DalamudCache): void {
  const dir = path.dirname(CACHE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), "utf-8");
}

/** Build the full cache (Phase 1 + 2). Prints progress to stderr. */
export async function buildCache(): Promise<DalamudCache> {
  process.stderr.write("[dalamud-mcp] Starting cache build...\n");

  const nsList = await crawlNamespaceIndex();
  process.stderr.write(
    `[dalamud-mcp] Found ${nsList.length} namespaces\n`
  );

  const namespaces: Namespace[] = [];
  let done = 0;

  for (const ns of nsList) {
    try {
      const types = await crawlNamespacePage(ns);
      namespaces.push({ ...ns, types });
      done++;
      process.stderr.write(
        `[dalamud-mcp] [${done}/${nsList.length}] ${ns.name} (${types.length} types)\n`
      );
      // Small delay to be polite to the server
      await new Promise((r) => setTimeout(r, 100));
    } catch (e) {
      process.stderr.write(`[dalamud-mcp] Error crawling ${ns.name}: ${e}\n`);
      namespaces.push({ ...ns, types: [] });
    }
  }

  const dalamudVersion = await fetchLatestDalamudTag();
  const cache: DalamudCache = {
    cacheVersion: CACHE_VERSION,
    builtAt: new Date().toISOString(),
    ...(dalamudVersion ? { dalamudVersion } : {}),
    namespaces,
  };

  saveCache(cache);
  process.stderr.write("[dalamud-mcp] Cache built and saved.\n");
  return cache;
}

/** Load from disk or build if missing. */
export async function getOrBuildCache(): Promise<DalamudCache> {
  const cached = loadCache();
  if (cached) {
    process.stderr.write(
      `[dalamud-mcp] Loaded cache from disk (built ${cached.builtAt})\n`
    );
    return cached;
  }
  return buildCache();
}

/** Ensure a type's members are loaded, fetching lazily if needed. */
export async function ensureMembers(typeEntry: TypeEntry): Promise<void> {
  if (typeEntry.membersLoaded) return;

  try {
    typeEntry.members = await crawlTypePage(typeEntry);
    typeEntry.membersLoaded = true;
  } catch (e) {
    process.stderr.write(
      `[dalamud-mcp] Error fetching members for ${typeEntry.name}: ${e}\n`
    );
  }
}
