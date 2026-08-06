// Just enough protobuf wire format for the one Lens request and reply. A schema-less reader: fields
// come back keyed by number, repeats preserved, and the caller decides what each one means.

const decoder = new TextDecoder("utf-8", { fatal: false });

function readVarint(bytes, at) {
  let result = 0n;
  let shift = 0n;
  let pos = at;
  for (;;) {
    if (pos >= bytes.length) throw new Error("truncated varint");
    const byte = bytes[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
    if (shift > 70n) throw new Error("varint too long");
  }
  return [result, pos];
}

function writeVarint(value) {
  const out = [];
  let v = BigInt(value);
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    out.push(byte);
  } while (v > 0n);
  return Uint8Array.from(out);
}

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// One length-delimited field, which is all the request needs.
export function field(number, payload) {
  return concat(writeVarint((number << 3) | 2), writeVarint(payload.length), payload);
}

// field number -> array of values. Length-delimited values stay raw so the caller can recurse.
export function decode(bytes) {
  const out = new Map();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  while (at < bytes.length) {
    const [key, next] = readVarint(bytes, at);
    at = next;
    const number = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (number === 0) throw new Error("field number 0");

    let value;
    if (wire === 0) {
      [value, at] = readVarint(bytes, at);
      value = Number(value);
    } else if (wire === 1) {
      value = view.getFloat64(at, true);
      at += 8;
    } else if (wire === 5) {
      value = view.getFloat32(at, true);
      at += 4;
    } else if (wire === 2) {
      const [len, start] = readVarint(bytes, at);
      const size = Number(len);
      if (start + size > bytes.length) throw new Error("truncated field");
      value = bytes.subarray(start, start + size);
      at = start + size;
    } else {
      throw new Error(`unsupported wire type ${wire}`);
    }

    if (!out.has(number)) out.set(number, []);
    out.get(number).push(value);
  }
  return out;
}

export const all = (message, number) => message?.get(number) || [];
export const one = (message, number) => all(message, number)[0];
// Decodes a nested message, returning null rather than throwing on anything unexpected.
export function sub(message, number) {
  const raw = one(message, number);
  if (!(raw instanceof Uint8Array)) return null;
  try {
    return decode(raw);
  } catch {
    return null;
  }
}
export function str(message, number) {
  const raw = one(message, number);
  return raw instanceof Uint8Array ? decoder.decode(raw) : "";
}
export const numeric = (message, number) => {
  const raw = one(message, number);
  return typeof raw === "number" ? raw : 0;
};
