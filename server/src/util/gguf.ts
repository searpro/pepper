import { open, type FileHandle } from 'node:fs/promises';

/**
 * Just enough of a GGUF header reader to tell what a file is: its
 * architecture and which metadata keys it carries. Values are read only for
 * the few string keys asked for; everything else — including the 150k-entry
 * tokenizer vocabulary — is skipped by length, so a multi-GB model costs a few
 * MB of reads at most.
 */

export interface GgufInfo {
  version: number;
  architecture?: string;
  /** Every metadata key present, e.g. `tokenizer.ggml.model`. */
  keys: Set<string>;
  /** Values of the string keys requested via `readStrings`. */
  strings: Record<string, string>;
  /** `general.file_type`: llama.cpp's quantization enum, when present. */
  fileType?: number;
}

const FIXED_SIZE: Record<number, number> = {
  0: 1, // uint8
  1: 1, // int8
  2: 2, // uint16
  3: 2, // int16
  4: 4, // uint32
  5: 4, // int32
  6: 4, // float32
  7: 1, // bool
  10: 8, // uint64
  11: 8, // int64
  12: 8, // float64
};
const STRING = 8;
const ARRAY = 9;

class Reader {
  private buf = Buffer.alloc(0);
  private bufStart = 0;
  pos = 0;

  constructor(private readonly fh: FileHandle) {}

  private async ensure(n: number): Promise<void> {
    const offset = this.pos - this.bufStart;
    if (offset >= 0 && offset + n <= this.buf.length) return;
    const size = Math.max(n, 1 << 20);
    const next = Buffer.alloc(size);
    const { bytesRead } = await this.fh.read(next, 0, size, this.pos);
    if (bytesRead < n) throw new Error('unexpected end of GGUF file');
    this.buf = next.subarray(0, bytesRead);
    this.bufStart = this.pos;
  }

  async bytes(n: number): Promise<Buffer> {
    await this.ensure(n);
    const offset = this.pos - this.bufStart;
    this.pos += n;
    return this.buf.subarray(offset, offset + n);
  }

  async u32(): Promise<number> {
    return (await this.bytes(4)).readUInt32LE(0);
  }

  async u64(): Promise<number> {
    const value = (await this.bytes(8)).readBigUInt64LE(0);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('GGUF length out of range');
    return Number(value);
  }

  skip(n: number): void {
    this.pos += n;
  }
}

/** Read a GGUF file's header. Throws when the file is not GGUF. */
export async function readGgufInfo(
  path: string,
  readStrings: string[] = ['general.architecture'],
): Promise<GgufInfo> {
  const fh = await open(path, 'r');
  try {
    const r = new Reader(fh);
    if ((await r.bytes(4)).toString('latin1') !== 'GGUF') throw new Error(`${path} is not a GGUF file`);
    const version = await r.u32();
    // Version 1 used 32-bit counts and lengths; 2 and 3 use 64-bit.
    const len = () => (version === 1 ? r.u32() : r.u64());
    await len(); // tensor count
    const kvCount = await len();

    const str = async () => (await r.bytes(await len())).toString('utf8');
    const skipValue = async (type: number): Promise<void> => {
      if (type in FIXED_SIZE) return r.skip(FIXED_SIZE[type]);
      if (type === STRING) return r.skip(await len());
      if (type === ARRAY) {
        const itemType = await r.u32();
        const count = await len();
        if (itemType in FIXED_SIZE) return r.skip(FIXED_SIZE[itemType] * count);
        for (let i = 0; i < count; i += 1) await skipValue(itemType);
        return;
      }
      throw new Error(`unknown GGUF value type ${type}`);
    };

    const keys = new Set<string>();
    const strings: Record<string, string> = {};
    let fileType: number | undefined;
    for (let i = 0; i < kvCount; i += 1) {
      const key = await str();
      const type = await r.u32();
      keys.add(key);
      if (type === STRING && readStrings.includes(key)) strings[key] = await str();
      else if (key === 'general.file_type' && (type === 4 || type === 5)) fileType = await r.u32();
      else await skipValue(type);
    }
    return { version, architecture: strings['general.architecture'], keys, strings, fileType };
  } finally {
    await fh.close();
  }
}
