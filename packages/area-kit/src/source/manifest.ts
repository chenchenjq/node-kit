import type { Coverage, Level } from "../types.js";

export interface SourceFile {
  name: string;
  path: string;
  level: Level;
  bytes: number;
  sha256: string;
}

export interface SourceManifest {
  source: string;
  sourceCommit: string;
  rulesVersion: string;
  versionCode: string;
  codeScheme: string;
  dataAsOf: string;
  sourcePublishedAt: string;
  coverage: Coverage;
  files: SourceFile[];
}

export const SOURCE_COMMIT = "c49d495b40ac73eb1a66f6eeae5f8fd10696f035";
export const SOURCE_KEY = "modood-administrative-divisions-of-china";

export const RAW_CHECKSUMS = [
  "b17e76dab634e24e0f56021f15737c0a526dc7f0c4e39d21abeba5a8668383cd",
  "a9c818e8a5120189173668b40882ce8bf59a7ec2b057c49d7a724a04bec727f2",
  "169b8d99654c28cbd285e771e00688837f77af8d50c2b703592146388d2a99ab",
  "831dc1c483079cee166717118e57f4b69ef6212c699dbd4bff868b59513ac14b",
  "31a824829aeef7b472fced6a3f9f8321cbd9fb26661052be98904f9763ec88ce",
] as const;

const levels: readonly Level[] = [1, 2, 3, 4, 5];
const names = ["provinces", "cities", "areas", "streets", "villages"] as const;
const bytes = [532, 7580, 85403, 1630789, 37730558] as const;

export const SOURCE_MANIFEST: SourceManifest = {
  source: "https://github.com/modood/Administrative-divisions-of-China",
  sourceCommit: SOURCE_COMMIT,
  rulesVersion: "v1",
  versionCode: `${SOURCE_KEY}:${SOURCE_COMMIT}:v1`,
  codeScheme: "statistics-source-short-codes",
  dataAsOf: "2023-06-30",
  sourcePublishedAt: "2023-09-11",
  coverage: {
    levels: [...levels],
    excluded: ["HK", "MO", "TW"],
    description: "固定于 2023-06-30 的统计来源快照，不代表最新数据，也不保证与当前行政建制一致。",
  },
  files: names.map((name, index) => ({
    name,
    path: `dist/${name}.csv`,
    level: levels[index]!,
    bytes: bytes[index]!,
    sha256: RAW_CHECKSUMS[index]!,
  })),
};

export function fixedSourceUrl(path: string): string {
  return `https://raw.githubusercontent.com/modood/Administrative-divisions-of-China/${SOURCE_COMMIT}/${path}`;
}
