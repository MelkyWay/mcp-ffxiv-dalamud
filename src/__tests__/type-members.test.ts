import { describe, it, expect } from "vitest";
import { MEMBER_KIND_ORDER, groupMembersByKind } from "../type-members.js";
import type { Member } from "../crawler.js";

describe("groupMembersByKind", () => {
  it("groups constructor members safely without prototype collisions", () => {
    const members: Member[] = [
      { name: "Ctor", kind: "constructor", declaration: "public Foo()", summary: "" },
      { name: "Bar", kind: "method", declaration: "void Bar()", summary: "" },
    ];

    const grouped = groupMembersByKind(members);

    expect(Array.isArray(grouped.constructor)).toBe(true);
    expect(grouped.constructor).toHaveLength(1);
    expect(grouped.constructor[0].name).toBe("Ctor");

    const namesInOrder: string[] = [];
    for (const kind of MEMBER_KIND_ORDER) {
      if (!grouped[kind]) continue;
      for (const m of grouped[kind]) {
        namesInOrder.push(m.name);
      }
    }
    expect(namesInOrder).toEqual(["Ctor", "Bar"]);
  });
});
