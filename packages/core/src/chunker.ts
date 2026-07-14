import {createHash} from "node:crypto";
import {createReadStream} from "node:fs";

export interface ProducedChunk {
  offset: number;
  data: Buffer;
  contentId: string;
}

const MIN = 256 * 1024;
const AVG_MASK = (1 << 20) - 1;
const MAX = 4 * 1024 * 1024;

const GEAR = (() => {
  let state = 0x9e3779b9 >>> 0;
  const table: number[] = [];
  for (let i = 0; i < 256; i++) {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17; state >>>= 0;
    state ^= state << 5; state >>>= 0;
    table.push(state >>> 0);
  }
  return table;
})();

export async function chunkFile(filePath: string, onChunk: (chunk: ProducedChunk) => Promise<void>): Promise<{contentId: string; size: number}> {
  const whole = createHash("sha256");
  let pieces: Buffer[] = [];
  let length = 0;
  let offset = 0;
  let rolling = 0;
  let total = 0;

  const flush = async (): Promise<void> => {
    if (length === 0) return;
    const data = Buffer.concat(pieces, length);
    const contentId = `sha256:${createHash("sha256").update(data).digest("hex")}`;
    await onChunk({offset, data, contentId});
    offset += length;
    pieces = [];
    length = 0;
    rolling = 0;
  };

  for await (const raw of createReadStream(filePath, {highWaterMark: 1024 * 1024})) {
    const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    whole.update(buffer);
    total += buffer.length;
    let start = 0;
    for (let i = 0; i < buffer.length; i++) {
      rolling = (((rolling << 1) >>> 0) + GEAR[buffer[i]!]!) >>> 0;
      length++;
      const boundary = length >= MIN && ((rolling & AVG_MASK) === 0 || length >= MAX);
      if (boundary) {
        pieces.push(buffer.subarray(start, i + 1));
        await flush();
        start = i + 1;
      }
    }
    if (start < buffer.length) pieces.push(buffer.subarray(start));
  }
  await flush();
  return {contentId: `sha256:${whole.digest("hex")}`, size: total};
}
