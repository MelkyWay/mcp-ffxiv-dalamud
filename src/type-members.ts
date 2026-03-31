import type { Member } from "./crawler.js";

export const MEMBER_KIND_ORDER: Member["kind"][] = [
  "constructor",
  "property",
  "field",
  "method",
  "event",
  "unknown",
];

export function groupMembersByKind(members: Member[]): Record<string, Member[]> {
  const grouped: Record<string, Member[]> = Object.create(null);
  for (const m of members) {
    if (!grouped[m.kind]) grouped[m.kind] = [];
    grouped[m.kind].push(m);
  }
  return grouped;
}
