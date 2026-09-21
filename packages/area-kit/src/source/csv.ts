import { createReadStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parse } from "csv-parse";
import type { Level } from "../types.js";

export type SourceRow = Record<string, string>;
export const ANCESTOR_FIELDS = ["provinceCode", "cityCode", "areaCode", "streetCode"] as const;
export const CODE_LENGTHS = [2, 4, 6, 9, 12] as const;

export async function* readCsvRows(file: string, level: Level): AsyncIterable<SourceRow> {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const utf8 = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try { callback(null, decoder.decode(chunk, { stream: true })); } catch (error) { callback(error as Error); }
    },
    flush(callback) {
      try { callback(null, decoder.decode()); } catch (error) { callback(error as Error); }
    },
  });
  let headersSeen = false;
  const parser = parse({
    bom: true, trim: false, cast: false, relax_column_count: false, skip_records_with_error: false,
    columns(headers: string[]) {
      const required = ["code", "name", ...ANCESTOR_FIELDS.slice(0, level - 1)];
      if (new Set(headers).size !== headers.length || required.some(field => !headers.includes(field))) {
        throw new Error("CSV headers are missing required fields or duplicated");
      }
      headersSeen = true;
      return headers;
    },
  });
  let failure: unknown;
  const complete = pipeline(createReadStream(file), utf8, parser).catch(error => { failure = error; });
  try {
    for await (const row of parser) yield row as SourceRow;
    await complete;
    if (failure !== undefined) throw failure;
    if (!headersSeen) throw new Error("CSV required headers are missing");
  } finally {
    parser.destroy();
    await complete;
  }
}
