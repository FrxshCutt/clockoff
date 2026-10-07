import type { AuditLog } from "@clockoff/validation/auditLogs";
import { humanizeEnum } from "@/lib/format";

/** Pure view-model helpers for the audit log page (unit tested in node). */

export type DiffKind = "added" | "removed" | "changed" | "unchanged";

export interface DiffEntry {
  /** Dot path of the leaf, e.g. `restrictionConfig.categories`; `(value)` for a non-object root. */
  readonly path: string;
  readonly kind: DiffKind;
  readonly before: unknown;
  readonly after: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function joinPath(parent: string, key: string): string {
  return parent ? `${parent}.${key}` : key;
}

function walk(before: unknown, after: unknown, path: string, out: DiffEntry[]): void {
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const key of keys) walk(before[key], after[key], joinPath(path, key), out);
    return;
  }
  const label = path || "(value)";
  if (before === undefined && after !== undefined)
    out.push({ path: label, kind: "added", before, after });
  else if (before !== undefined && after === undefined)
    out.push({ path: label, kind: "removed", before, after });
  else if (!sameValue(before, after)) out.push({ path: label, kind: "changed", before, after });
  else out.push({ path: label, kind: "unchanged", before, after });
}

/**
 * Leaf-by-leaf comparison of two snapshots. Objects are walked recursively (union of keys, sorted);
 * arrays and primitives are compared as whole values at their path. `null` snapshots (a pure create or a
 * pure delete) compare as "no keys", so every leaf of the other side reads as added/removed.
 */
export function diffJson(before: unknown, after: unknown): DiffEntry[] {
  const out: DiffEntry[] = [];
  const left = before === null ? undefined : before;
  const right = after === null ? undefined : after;
  if (left === undefined && right === undefined) return out;
  if (isPlainObject(left ?? {}) && isPlainObject(right ?? {})) {
    walk(left ?? {}, right ?? {}, "", out);
    return out;
  }
  walk(left, right, "", out);
  return out;
}

export function changedEntries(entries: readonly DiffEntry[]): DiffEntry[] {
  return entries.filter((entry) => entry.kind !== "unchanged");
}

/** `policy.published` → "Policy published"; `employee.invite.resent` → "Employee invite resent". */
export function describeAuditAction(action: string): string {
  const words = action
    .split(/[.:/]+/)
    .filter(Boolean)
    .map((part) => humanizeEnum(part).toLowerCase())
    .join(" ")
    .trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Action";
}

/** `policy` → "Policy"; `breakPolicy` → "Break policy". */
export function describeEntityType(entityType: string): string {
  const spaced = entityType.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return humanizeEnum(spaced) || "Record";
}

/** First 8 characters of a UUID (or the whole id when it is already short). */
export function shortId(id: string | null | undefined): string | null {
  if (!id) return null;
  return id.length > 12 ? id.slice(0, 8) : id;
}

export function formatJson(value: unknown): string {
  if (value === undefined) return "—";
  try {
    const text = JSON.stringify(value, null, 2);
    return text === undefined ? "—" : text;
  } catch {
    return String(value);
  }
}

/** "Jane Smith" / "jane@example.com" / "System". */
export function describeActor(entry: Pick<AuditLog, "actor">): string {
  if (!entry.actor) return "System";
  return entry.actor.name.trim() || entry.actor.email || "Manager";
}

/** Whether the entry carries a snapshot worth opening. */
export function hasSnapshot(entry: Pick<AuditLog, "before" | "after">): boolean {
  return entry.before !== null && entry.before !== undefined
    ? true
    : entry.after !== null && entry.after !== undefined;
}
