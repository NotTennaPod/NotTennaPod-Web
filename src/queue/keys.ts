// Contract-v1 queue keys (PROTOCOL §3.6; NotTennaPod-Server internal/contract):
// reduced dyadic rationals M / 2^N strictly between 0 and 1, written
// "q1:<n>:<m hex>". A new key between two others carries its position-write
// ID u: M ≡ 2u+1 (mod 2^129).

export interface QueueKey {
  n: number;
  m: bigint;
}

export const MAX_EXPONENT = 1 << 20;
const TWO129 = 1n << 129n;
const THRESH = 1n << 130n;

export function keyString(k: QueueKey): string {
  return `q1:${k.n}:${k.m.toString(16)}`;
}

export function parseKey(s: string): QueueKey | null {
  const parts = s.split(":");
  if (parts.length !== 3 || parts[0] !== "q1") return null;
  const [, ns, ms] = parts as [string, string, string];
  if (!/^(0|[1-9][0-9]*)$/.test(ns) || !/^(0|[1-9a-f][0-9a-f]*)$/.test(ms)) return null;
  const n = Number(ns);
  if (!Number.isSafeInteger(n) || n > MAX_EXPONENT) return null;
  const m = BigInt(`0x${ms}`);
  if ((m & 1n) !== 1n || m <= 0n || m >= 1n << BigInt(n)) return null;
  return { n, m };
}

export function compareKeys(a: QueueKey, b: QueueKey): number {
  const l = a.m << BigInt(b.n);
  const r = b.m << BigInt(a.n);
  return l < r ? -1 : l > r ? 1 : 0;
}

function bitLength(x: bigint): number {
  return x === 0n ? 0 : x.toString(2).length;
}

/** uuidBytes is a position ID's 128 bits. */
export function uuidValue(uuid: string): bigint {
  const hex = uuid.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error("queue: bad position ID");
  return BigInt(`0x${hex}`);
}

/** between allocates the key strictly between low and high (null: the sentinels 0 and 1) for position ID u. */
export function between(low: QueueKey | null, high: QueueKey | null, u: bigint): QueueKey {
  let denom = low ? low.n : 0;
  if (high && high.n > denom) denom = high.n;
  const lowNum = low ? low.m << BigInt(denom - low.n) : 0n;
  const highNum = high ? high.m << BigInt(denom - high.n) : 1n << BigInt(denom);
  const diff = highNum - lowNum;
  if (diff <= 0n) throw new Error("queue: bounds not increasing");
  const target = THRESH << BigInt(denom);
  let n = Math.max(1, 130 + denom - bitLength(diff) + 1);
  while ((diff << BigInt(n)) <= target) n++;
  if (n > MAX_EXPONENT) throw new Error("queue: key exponent bound exceeded");
  const base = ((lowNum << BigInt(n)) >> BigInt(denom)) + 1n;
  const r = (u << 1n) + 1n;
  const delta = (((r - base) % TWO129) + TWO129) % TWO129;
  const key = { n, m: base + delta };
  if ((low && compareKeys(low, key) >= 0) || (high && compareKeys(key, high) >= 0)) throw new Error("queue: allocator postcondition failed");
  return key;
}
