const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const utf8 = (s: string): Uint8Array<ArrayBuffer> => encoder.encode(s) as Uint8Array<ArrayBuffer>;
export const fromUtf8 = (b: Uint8Array): string => decoder.decode(b);

export function toBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const toHex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

export async function sha256(b: Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource)));
}

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/** gzip through the platform's CompressionStream (browsers and Node 18+). */
export async function gzip(b: Uint8Array): Promise<Uint8Array> {
  return pipe(b, new CompressionStream('gzip') as ReadableWritablePair<Uint8Array, Uint8Array>);
}

export async function gunzip(b: Uint8Array): Promise<Uint8Array> {
  return pipe(b, new DecompressionStream('gzip') as ReadableWritablePair<Uint8Array, Uint8Array>);
}

async function pipe(b: Uint8Array, stream: ReadableWritablePair<Uint8Array, Uint8Array>): Promise<Uint8Array> {
  const blob = new Blob([b as BlobPart]);
  const out = await new Response(blob.stream().pipeThrough(stream)).arrayBuffer();
  return new Uint8Array(out);
}
