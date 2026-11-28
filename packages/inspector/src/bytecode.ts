export type Hex = `0x${string}`;

function toBytes(code: string): Uint8Array {
  const hex = code.startsWith("0x") ? code.slice(2) : code;
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const hexOf = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** Drops Solidity's CBOR metadata tail: …<cbor map><2-byte big-endian length>. */
function stripMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 4) return bytes;
  const len = (bytes[bytes.length - 2]! << 8) | bytes[bytes.length - 1]!;
  const start = bytes.length - 2 - len;
  if (len === 0 || start < 0) return bytes;
  const head = bytes[start]!;
  return head >= 0xa1 && head <= 0xa4 ? bytes.slice(0, start) : bytes;
}

export function* walkOpcodes(code: string): Generator<{ pc: number; op: number; data: string }> {
  const bytes = stripMetadata(toBytes(code));
  let pc = 0;
  while (pc < bytes.length) {
    const op = bytes[pc]!;
    const n = op >= 0x60 && op <= 0x7f ? op - 0x5f : 0;
    yield { pc, op, data: hexOf(bytes.slice(pc + 1, pc + 1 + n)) };
    pc += 1 + n;
  }
}

export function usesOpcode(code: string, op: number): boolean {
  for (const o of walkOpcodes(code)) if (o.op === op) return true;
  return false;
}

/** Function selectors a dispatcher compares against: PUSH4, and PUSH3 for selectors with a leading zero byte. */
export function extractSelectors(code: string): Set<string> {
  const out = new Set<string>();
  for (const o of walkOpcodes(code)) {
    if (o.op === 0x63 && o.data.length === 8) out.add(`0x${o.data}`);
    else if (o.op === 0x62 && o.data.length === 6) out.add(`0x00${o.data}`);
  }
  return out;
}

const EIP1167 = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i;

export function minimalProxyTarget(code: string): Hex | null {
  const m = EIP1167.exec(code);
  return m ? (`0x${m[1]!.toLowerCase()}` as Hex) : null;
}

/** EIP-7702's delegation designator: 0xef0100 and the 20-byte address whose code the account runs, nothing else. */
const EIP7702 = /^0xef0100[0-9a-f]{40}$/i;
/** Arbitrum Stylus marks a WebAssembly program's code with this prefix. */
const STYLUS = /^0xeff000/i;

/**
 * Code that isn't EVM bytecode to scan: an EIP-7702 delegated account (`eip7702`: an account whose key points it at
 * another contract's code, and can point it elsewhere at any time) or an Arbitrum Stylus program (`stylus`: WebAssembly).
 * Neither has a dispatcher or opcodes this engine reads. `null` for anything else.
 */
export function opaqueCode(code: string): "eip7702" | "stylus" | null {
  return EIP7702.test(code) ? "eip7702" : STYLUS.test(code) ? "stylus" : null;
}
