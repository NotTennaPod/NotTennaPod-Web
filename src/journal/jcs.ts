import { sha256Hex } from "../util/random.ts";

// RFC 8785 canonical JSON (PROTOCOL §3.1): object keys sorted by UTF-16
// code units, ECMAScript number and string serialization. The facts the
// browser writes hold integers, strings, booleans, null, arrays and objects.

export function canonical(v: unknown): string {
  if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("jcs: non-finite number");
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (typeof v === "object") {
    const keys = Object.keys(v as object)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  throw new Error(`jcs: cannot encode ${typeof v}`);
}

const encoder = new TextEncoder();

export function utf8(s: string): Uint8Array {
  return encoder.encode(s);
}

/** contentHash is a fact's content hash: lowercase hex SHA-256 of its canonical bytes. */
export async function contentHash(fact: unknown): Promise<string> {
  return sha256Hex(utf8(canonical(fact)));
}

export function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
