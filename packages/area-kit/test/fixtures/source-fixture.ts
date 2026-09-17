import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Level } from "../../src/types.js";
import { SOURCE_MANIFEST } from "../../src/source/manifest.js";
import type { SourceManifest } from "../../src/source/manifest.js";
import { sha256 } from "../../src/source/prepare.js";

export async function sourceFixture(options: { conflict?: boolean; missingParent?: boolean; blankCode?: boolean; duplicate?: boolean } = {}): Promise<{ directory: string; manifest: SourceManifest }> {
  const directory = await mkdtemp(join(tmpdir(), "area-source-fixture-"));
  await mkdir(join(directory, "dist"));
  const contents = [
    "code,name\n01,合成省\n",
    "code,name,provinceCode\n0101,合成市,01\n",
    `code,name,cityCode,provinceCode\n${options.blankCode ? " 010101" : "010101"},同名县,${options.missingParent ? "0199" : "0101"},01\n010102,同名县,0101,01\n${options.conflict ? "010101,同名县,0101,02\n" : ""}${options.duplicate ? "010101,同名县,0101,01\n" : ""}`,
    "code,name,areaCode,cityCode,provinceCode\n010101001,合成街道,010101,0101,01\n",
    "code,name,streetCode,areaCode,cityCode,provinceCode\n010101001001,合成村,010101001,010101,0101,01\n",
  ];
  const manifest: SourceManifest = {
    ...structuredClone(SOURCE_MANIFEST), source: "synthetic-test-only", sourceCommit: "synthetic-test-only",
    versionCode: "synthetic-test-only:v1", codeScheme: "synthetic-test-only:lengths-2-4-6-9-12",
    coverage: { levels: [1,2,3,4,5], excluded: [], description: "Synthetic fixture; no administrative coding claim" },
    files: SOURCE_MANIFEST.files.map((file, index) => ({ ...file, level: (index + 1) as Level, bytes: Buffer.byteLength(contents[index]!), sha256: sha256(Buffer.from(contents[index]!)) })),
  };
  for (const file of manifest.files) await writeFile(join(directory, file.path), contents[file.level - 1]!);
  return { directory, manifest };
}
