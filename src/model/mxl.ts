// Minimal reader for compressed MusicXML (.mxl = zip). Returns the root score XML so StaffLens can
// read <harmony> itself (alphaTab reads .mxl too, but drops the bass note of slash chords).

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

function entries(b: Uint8Array): ZipEntry[] {
  // End of central directory: signature 0x06054b50, within the last 64 KiB + 22 bytes.
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (u32(b, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = u16(b, eocd + 10);
  let p = u32(b, eocd + 16);
  const out: ZipEntry[] = [];
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (u32(b, p) !== 0x02014b50) break;
    const method = u16(b, p + 10);
    const compressedSize = u32(b, p + 20);
    const nameLen = u16(b, p + 28);
    const extraLen = u16(b, p + 30);
    const commentLen = u16(b, p + 32);
    const localOffset = u32(b, p + 42);
    out.push({ name: dec.decode(b.subarray(p + 46, p + 46 + nameLen)), method, compressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function readEntry(b: Uint8Array, e: ZipEntry): Promise<Uint8Array> {
  const p = e.localOffset;
  if (u32(b, p) !== 0x04034b50) throw new Error('bad zip entry');
  const start = p + 30 + u16(b, p + 26) + u16(b, p + 28);
  const data = b.slice(start, start + e.compressedSize);
  if (e.method === 0) return data;
  if (e.method !== 8) throw new Error(`unsupported zip compression ${e.method}`);
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The main score XML inside an .mxl file, or null if it cannot be read. */
export async function readMxlScoreXml(bytes: Uint8Array): Promise<string | null> {
  try {
    const list = entries(bytes);
    const dec = new TextDecoder();
    let path: string | undefined;
    const container = list.find((e) => e.name === 'META-INF/container.xml');
    if (container) {
      const xml = dec.decode(await readEntry(bytes, container));
      path = /<rootfile[^>]*full-path="([^"]+)"/.exec(xml)?.[1];
    }
    const entry = list.find((e) => e.name === path) ?? list.find((e) => !e.name.startsWith('META-INF/') && /\.(xml|musicxml)$/i.test(e.name));
    if (!entry) return null;
    return dec.decode(await readEntry(bytes, entry));
  } catch {
    return null;
  }
}
