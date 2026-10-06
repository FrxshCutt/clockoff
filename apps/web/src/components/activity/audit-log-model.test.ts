import { describe, expect, it } from "vitest";
import {
  changedEntries,
  describeActor,
  describeAuditAction,
  describeEntityType,
  diffJson,
  formatJson,
  hasSnapshot,
  shortId,
} from "./audit-log-model";

describe("diffJson", () => {
  it("walks nested objects and classifies every leaf", () => {
    const entries = diffJson({ a: 1, b: { c: 1, d: 2 } }, { a: 1, b: { c: 2 }, e: true });
    expect(entries).toEqual([
      { path: "a", kind: "unchanged", before: 1, after: 1 },
      { path: "b.c", kind: "changed", before: 1, after: 2 },
      { path: "b.d", kind: "removed", before: 2, after: undefined },
      { path: "e", kind: "added", before: undefined, after: true },
    ]);
    expect(changedEntries(entries).map((entry) => entry.path)).toEqual(["b.c", "b.d", "e"]);
  });

  it("treats a null snapshot as 'no fields', so creates and deletes read as added / removed", () => {
    expect(diffJson(null, { name: "Front of house", status: "DRAFT" })).toEqual([
      { path: "name", kind: "added", before: undefined, after: "Front of house" },
      { path: "status", kind: "added", before: undefined, after: "DRAFT" },
    ]);
    expect(diffJson({ name: "x" }, null)).toEqual([{ path: "name", kind: "removed", before: "x", after: undefined }]);
    expect(diffJson(null, null)).toEqual([]);
    expect(diffJson(undefined, undefined)).toEqual([]);
  });

  it("compares arrays and other non-objects as whole values at their path", () => {
    expect(diffJson({ tags: [1, 2] }, { tags: [1, 3] })).toEqual([{ path: "tags", kind: "changed", before: [1, 2], after: [1, 3] }]);
    expect(diffJson({ tags: [1, 2] }, { tags: [1, 2] })).toEqual([{ path: "tags", kind: "unchanged", before: [1, 2], after: [1, 2] }]);
    expect(diffJson({ at: null }, { at: "2026-10-06T09:00:00.000Z" })).toEqual([
      { path: "at", kind: "changed", before: null, after: "2026-10-06T09:00:00.000Z" },
    ]);
  });

  it("handles non-object roots", () => {
    expect(diffJson(1, 2)).toEqual([{ path: "(value)", kind: "changed", before: 1, after: 2 }]);
    expect(diffJson("same", "same")).toEqual([{ path: "(value)", kind: "unchanged", before: "same", after: "same" }]);
    expect(diffJson({ a: 1 }, "text")).toEqual([{ path: "(value)", kind: "changed", before: { a: 1 }, after: "text" }]);
  });

  it("sorts keys so the order is stable whatever the server sent", () => {
    expect(diffJson({ z: 1, a: 1 }, { a: 2, z: 1 }).map((entry) => entry.path)).toEqual(["a", "z"]);
  });
});

describe("labels", () => {
  it("turns action codes into sentences", () => {
    expect(describeAuditAction("policy.published")).toBe("Policy published");
    expect(describeAuditAction("employee.invite.resent")).toBe("Employee invite resent");
    expect(describeAuditAction("override:created")).toBe("Override created");
    expect(describeAuditAction("DEVICE_DEACTIVATED")).toBe("Device deactivated");
    expect(describeAuditAction("")).toBe("Action");
  });

  it("turns entity types into labels", () => {
    expect(describeEntityType("policy")).toBe("Policy");
    expect(describeEntityType("breakPolicy")).toBe("Break policy");
    expect(describeEntityType("shift_import")).toBe("Shift import");
    expect(describeEntityType("")).toBe("Record");
  });

  it("shortens UUIDs but leaves short ids alone", () => {
    expect(shortId("6f1c2c1e-4d1b-4a8e-9b51-2f6f0f1c9a10")).toBe("6f1c2c1e");
    expect(shortId("abc123")).toBe("abc123");
    expect(shortId("123456789012")).toBe("123456789012");
    expect(shortId(null)).toBeNull();
    expect(shortId("")).toBeNull();
  });

  it("names the actor with sensible fallbacks", () => {
    expect(describeActor({ actor: null })).toBe("System");
    expect(describeActor({ actor: { id: "u", name: "Ada Lovelace", email: "ada@example.com" } })).toBe("Ada Lovelace");
    expect(describeActor({ actor: { id: "u", name: "  ", email: "ada@example.com" } })).toBe("ada@example.com");
    expect(describeActor({ actor: { id: "u", name: "", email: null } })).toBe("Manager");
  });

  it("knows whether an entry has anything to open", () => {
    expect(hasSnapshot({ before: null, after: null })).toBe(false);
    expect(hasSnapshot({ before: { a: 1 }, after: null })).toBe(true);
    expect(hasSnapshot({ before: null, after: { a: 1 } })).toBe(true);
  });

  it("pretty-prints JSON and shows a dash for nothing", () => {
    expect(formatJson(undefined)).toBe("—");
    expect(formatJson({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(formatJson("text")).toBe('"text"');
    expect(formatJson(null)).toBe("null");
  });
});
