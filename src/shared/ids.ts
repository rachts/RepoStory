import { randomUUID } from "node:crypto";

export function stableId(prefix: string, ...parts: string[]): string {
  let hash = 2166136261;
  for (const char of parts.join("\u0000")) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `${prefix}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function opaqueId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

export function nowIso(): string { return new Date().toISOString(); }
