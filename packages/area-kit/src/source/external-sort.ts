import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile, open } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { SourceRow } from "./csv.js";

const CHUNK_ROWS = 10_000;
const MERGE_FAN_IN = 64;
export function sourceTuple(row: SourceRow): string {
  return JSON.stringify(Object.keys(row).sort().map(key => [key, row[key]]));
}
function compare(left: SourceRow, right: SourceRow): number {
  const a = left.code ?? "", b = right.code ?? "";
  if (a !== b) return a < b ? -1 : 1;
  const c = sourceTuple(left), d = sourceTuple(right);
  return c === d ? 0 : c < d ? -1 : 1;
}
export async function* readJsonLines<T>(file: string): AsyncIterable<T> {
  const input = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try { for await (const line of lines) { if (line) yield JSON.parse(line) as T; } }
  finally { lines.close(); input.destroy(); }
}
async function* merge(files: string[]): AsyncIterable<SourceRow> {
  const readers = files.map(file => readJsonLines<SourceRow>(file)[Symbol.asyncIterator]());
  const heads = await Promise.all(readers.map(reader => reader.next()));
  try {
    while (true) {
      let selected = -1;
      for (let index = 0; index < heads.length; index++) {
        if (!heads[index]!.done && (selected < 0 || compare(heads[index]!.value, heads[selected]!.value) < 0)) selected = index;
      }
      if (selected < 0) break;
      yield heads[selected]!.value;
      heads[selected] = await readers[selected]!.next();
    }
  } finally { await Promise.all(readers.map(reader => reader.return?.())); }
}
/** Keeps at most 10000 source rows and 64 merge heads in memory. */
export async function* externalSort(rows: AsyncIterable<SourceRow>, directory: string): AsyncIterable<SourceRow> {
  const temporary = await mkdtemp(join(directory, ".sort-"));
  let sequence = 0;
  let files: string[] = [];
  let chunk: SourceRow[] = [];
  async function flush() {
    chunk.sort(compare);
    const file = join(temporary, `${sequence++}.jsonl`);
    await writeFile(file, chunk.map(row => JSON.stringify(row) + "\n").join(""));
    files.push(file); chunk = [];
  }
  try {
    for await (const row of rows) { chunk.push(row); if (chunk.length === CHUNK_ROWS) await flush(); }
    if (chunk.length) await flush();
    while (files.length > MERGE_FAN_IN) {
      const next: string[] = [];
      for (let index = 0; index < files.length; index += MERGE_FAN_IN) {
        const batch = files.slice(index, index + MERGE_FAN_IN);
        const file = join(temporary, `${sequence++}.jsonl`);
        const output = await open(file, "w");
        try { for await (const row of merge(batch)) await output.write(JSON.stringify(row) + "\n"); }
        finally { await output.close(); }
        await Promise.all(batch.map(path => rm(path)));
        next.push(file);
      }
      files = next;
    }
    yield* merge(files);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
