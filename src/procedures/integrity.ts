import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import type { OperationalProcedure } from "./types";

function canonicalValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON does not support non-finite numbers.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalValue).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) =>
      `${JSON.stringify(key)}:${canonicalValue(record[key])}`
    ).join(",")}}`;
  }
  throw new TypeError(`Canonical JSON does not support ${typeof value} values.`);
}

/** Stable JSON representation used by every procedure revision hash. */
export function canonicalProcedureJson(
  procedure: OperationalProcedure | Omit<OperationalProcedure, "contentHash">,
): string {
  const { contentHash: _excluded, ...document } =
    procedure as OperationalProcedure;
  return canonicalValue(document);
}

/** SHA-256 over any JSON-compatible value using sorted object keys. */
export function canonicalSha256(value: unknown): string {
  return `sha256:${bytesToHex(sha256(utf8ToBytes(canonicalValue(value))))}`;
}

/** SHA-256 over the canonical procedure document, excluding contentHash itself. */
export function procedureContentHash(
  procedure: OperationalProcedure | Omit<OperationalProcedure, "contentHash">,
): string {
  return `sha256:${bytesToHex(sha256(utf8ToBytes(canonicalProcedureJson(procedure))))}`;
}

export function hasValidProcedureContentHash(procedure: OperationalProcedure): boolean {
  return procedure.contentHash === procedureContentHash(procedure);
}
