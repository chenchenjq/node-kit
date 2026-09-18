import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import type { SourceManifest } from "../src/source/manifest.js";
import {
  downloadVerified,
  prepareSourceWithManifest,
  sha256,
} from "../src/source/prepare.js";

const DOWNLOAD_TIMEOUT_MS = 30_000;

function fixtureManifest(contents: string): SourceManifest {
  return {
    source: "https://example.test/source",
    sourceCommit: "fixture-commit",
    rulesVersion: "v1",
    versionCode: "fixture:v1",
    codeScheme: "fixture-codes",
    dataAsOf: "2023-06-30",
    sourcePublishedAt: "2023-09-11",
    coverage: { levels: [1], excluded: [], description: "fixture" },
    files: [{ name: "provinces", path: "dist/provinces.csv", level: 1, bytes: Buffer.byteLength(contents), sha256: sha256(Buffer.from(contents)) }],
  };
}

function fixtureFetcher(contents: string): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url.endsWith("dist/provinces.csv")) return new Response(contents);
    if (url.endsWith("README.md")) return new Response("# upstream readme\n");
    if (url.endsWith("LICENSE")) return new Response("upstream license text\n");
    return new Response(null, { status: 404 });
  };
}

it("rejects wrong bytes instead of publishing a prepared file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "area-prepare-test-"));
  const file = join(dir, "provinces.csv");
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls += 1;
    return new Response("wrong bytes");
  };

  await expect(downloadVerified("https://example.test/data", file, "0".repeat(64), fetcher))
    .rejects.toMatchObject({ code: "IMPORT_CONFLICT" });
  await expect(access(file)).rejects.toBeDefined();
  expect(calls).toBe(1);
});

it("does not leave a partial file when a response stream is interrupted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "area-prepare-test-"));
  const file = join(dir, "provinces.csv");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("partial"));
      controller.error(new Error("connection lost"));
    },
  });
  const fetcher: typeof fetch = async () => new Response(stream);

  await expect(downloadVerified("https://example.test/data", file, "0".repeat(64), fetcher))
    .rejects.toMatchObject({ code: "IMPORT_CONFLICT" });
  await expect(access(`${file}.partial`)).rejects.toBeDefined();
  await expect(access(file)).rejects.toBeDefined();
});

it("rejects HTTP errors before writing the destination", async () => {
  const dir = await mkdtemp(join(tmpdir(), "area-prepare-test-"));
  const file = join(dir, "provinces.csv");
  await writeFile(`${file}.partial`, "stale partial");
  const fetcher: typeof fetch = async () => new Response(null, { status: 404 });

  await expect(downloadVerified("https://example.test/data", file, "0".repeat(64), fetcher))
    .rejects.toMatchObject({ code: "IMPORT_CONFLICT" });
  await expect(access(file)).rejects.toBeDefined();
  await expect(access(`${file}.partial`)).rejects.toBeDefined();
});

it("retries transient server failures no more than three times", async () => {
  const dir = await mkdtemp(join(tmpdir(), "area-prepare-test-"));
  const file = join(dir, "provinces.csv");
  await writeFile(`${file}.partial`, "stale partial");
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls += 1;
    return new Response(null, { status: 503 });
  };

  await expect(downloadVerified("https://example.test/data", file, "0".repeat(64), fetcher))
    .rejects.toMatchObject({ code: "IMPORT_CONFLICT" });
  expect(calls).toBe(3);
  await expect(access(file)).rejects.toBeDefined();
  await expect(access(`${file}.partial`)).rejects.toBeDefined();
});

it("aborts a stalled fetch at the bounded deadline without retrying", async () => {
  vi.useFakeTimers();
  try {
    const dir = await mkdtemp(join(tmpdir(), "area-prepare-test-"));
    const file = join(dir, "provinces.csv");
    await writeFile(`${file}.partial`, "stale partial");
    let calls = 0;
    let aborted = false;
    const fetcher: typeof fetch = async (_input, init) => {
      calls += 1;
      if (calls > 1) throw new DOMException("cancelled", "AbortError");
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            controller.error(new DOMException("timed out", "AbortError"));
          });
        },
      }));
    };
    const pending = downloadVerified("https://example.test/data", file, "0".repeat(64), fetcher);

    await vi.advanceTimersByTimeAsync(DOWNLOAD_TIMEOUT_MS);

    expect(aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({ code: "IMPORT_CONFLICT" });
    expect(calls).toBe(1);
    await expect(access(`${file}.partial`)).rejects.toBeDefined();
  } finally {
    vi.useRealTimers();
  }
});

it("does not retry an aborted fetch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "area-prepare-test-"));
  const file = join(dir, "provinces.csv");
  await writeFile(`${file}.partial`, "stale partial");
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls += 1;
    throw new DOMException("cancelled", "AbortError");
  };

  await expect(downloadVerified("https://example.test/data", file, "0".repeat(64), fetcher))
    .rejects.toMatchObject({ code: "IMPORT_CONFLICT" });
  expect(calls).toBe(1);
  await expect(access(`${file}.partial`)).rejects.toBeDefined();
});

it("rejects a source file with the right checksum but wrong manifest byte count", async () => {
  const directory = await mkdtemp(join(tmpdir(), "area-prepare-test-"));
  const manifest = fixtureManifest("province\n");
  manifest.files[0]!.bytes += 1;

  await expect(prepareSourceWithManifest(directory, manifest, fixtureFetcher("province\n")))
    .rejects.toMatchObject({ code: "IMPORT_CONFLICT" });
  await expect(access(join(directory, "dist", "provinces.csv"))).rejects.toBeDefined();
});

it("preserves the upstream license bytes and records their digest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "area-prepare-test-"));
  const prepared = await prepareSourceWithManifest(directory, fixtureManifest("province\n"), fixtureFetcher("province\n"));
  const record = JSON.parse(await readFile(join(directory, "prepared-source.json"), "utf8")) as {
    documents: { license: { sha256: string } };
  };

  expect(await readFile(join(directory, "LICENSE"), "utf8")).toBe("upstream license text\n");
  expect(record.documents.license.sha256).toBe(sha256(Buffer.from("upstream license text\n")));
  expect(prepared.retrievedAt).toMatch(/Z$/);
});

it("keeps the original retrieval time when every verified file is reused", async () => {
  const directory = await mkdtemp(join(tmpdir(), "area-prepare-test-"));
  const manifest = fixtureManifest("province\n");
  const first = await prepareSourceWithManifest(directory, manifest, fixtureFetcher("province\n"));
  const noNetwork: typeof fetch = async () => {
    throw new Error("a verified snapshot must not download again");
  };

  const second = await prepareSourceWithManifest(directory, manifest, noNetwork);

  expect(second.retrievedAt).toBe(first.retrievedAt);
});

it("does not trust a malformed prepared manifest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "area-prepare-test-"));
  const manifest = fixtureManifest("province\n");
  await prepareSourceWithManifest(directory, manifest, fixtureFetcher("province\n"));
  await writeFile(join(directory, "prepared-source.json"), "{not json");
  let calls = 0;
  const unavailable: typeof fetch = async () => {
    calls += 1;
    return new Response(null, { status: 404 });
  };

  await expect(prepareSourceWithManifest(directory, manifest, unavailable))
    .rejects.toMatchObject({ code: "IMPORT_CONFLICT" });
  expect(calls).toBeGreaterThan(0);
});
