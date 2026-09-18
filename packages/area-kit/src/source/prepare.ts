import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { AreaKitError } from "../errors.js";
import { SOURCE_MANIFEST, fixedSourceUrl } from "./manifest.js";
import type { SourceFile, SourceManifest } from "./manifest.js";

export interface PreparedSource {
  directory: string;
  manifest: SourceManifest;
  retrievedAt: string;
}

interface PreparedDocument {
  path: string;
  sha256: string;
  retrievedAt: string;
}

interface StoredPreparedSource extends PreparedSource {
  documents: {
    readme: PreparedDocument;
    license: PreparedDocument;
  };
}

interface VerifiedFile {
  bytes: number;
  sha256: string;
}

const DOWNLOAD_TIMEOUT_MS = 30_000;

class DownloadFailure extends Error {
  constructor(readonly retryable: boolean) {
    super("source download failed");
  }
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function conflict(): AreaKitError {
  return new AreaKitError("IMPORT_CONFLICT");
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

async function verifyExistingFile(path: string): Promise<VerifiedFile | null> {
  try {
    await stat(path);
  } catch {
    return null;
  }

  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.byteLength;
    hash.update(value);
  }
  return { bytes, sha256: hash.digest("hex") };
}

async function writeResponse(
  response: Response,
  destination: string,
): Promise<VerifiedFile> {
  if (response.body === null) throw new DownloadFailure(false);

  const partial = `${destination}.partial`;
  const hash = createHash("sha256");
  let bytes = 0;
  const digest = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength;
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  await mkdir(dirname(destination), { recursive: true });
  await rm(partial, { force: true });
  try {
    await pipeline(
      Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream),
      digest,
      createWriteStream(partial, { flags: "w" }),
    );
    return { bytes, sha256: hash.digest("hex") };
  } catch (error) {
    await rm(partial, { force: true });
    if (error instanceof DownloadFailure) throw error;
    throw new DownloadFailure(true);
  }
}

async function downloadOnce(
  url: string,
  destination: string,
  fetcher: typeof fetch,
): Promise<VerifiedFile> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetcher(url, { signal: controller.signal });
    if (!response.ok) throw new DownloadFailure(response.status >= 500 && response.status <= 599);
    return await writeResponse(response, destination);
  } catch (error) {
    if (controller.signal.aborted || isAbortError(error)) throw new DownloadFailure(false);
    if (error instanceof DownloadFailure) throw error;
    throw new DownloadFailure(true);
  } finally {
    clearTimeout(timeout);
  }
}

async function downloadWithRetry(
  url: string,
  destination: string,
  expectedSha256: string | undefined,
  expectedBytes: number | undefined,
  fetcher: typeof fetch,
): Promise<VerifiedFile> {
  const partial = `${destination}.partial`;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const result = await downloadOnce(url, destination, fetcher);
      if (
        (expectedSha256 !== undefined && result.sha256 !== expectedSha256) ||
        (expectedBytes !== undefined && result.bytes !== expectedBytes)
      ) {
        await rm(partial, { force: true });
        throw new DownloadFailure(false);
      }
      await rename(partial, destination);
      return result;
    } catch (error) {
      await rm(partial, { force: true });
      if (!(error instanceof DownloadFailure) || !error.retryable || attempt === 3) throw conflict();
    }
  }
  throw conflict();
}

export async function downloadVerified(
  url: string,
  destination: string,
  expectedSha256: string,
  fetcher: typeof fetch,
): Promise<void> {
  await downloadWithRetry(url, destination, expectedSha256, undefined, fetcher);
}

function sameManifest(left: SourceManifest, right: SourceManifest): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

async function readPreparedRecord(path: string): Promise<StoredPreparedSource | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof value !== "object" || value === null) return null;
    const record = value as Partial<StoredPreparedSource>;
    if (
      typeof record.directory !== "string" ||
      record.manifest === undefined ||
      !validTimestamp(record.retrievedAt) ||
      record.documents === undefined
    ) return null;
    return record as StoredPreparedSource;
  } catch {
    return null;
  }
}

async function sourceFileMatches(directory: string, file: SourceFile): Promise<boolean> {
  const verified = await verifyExistingFile(join(directory, file.path));
  return verified?.bytes === file.bytes && verified.sha256 === file.sha256;
}

async function documentMatches(directory: string, document: PreparedDocument): Promise<boolean> {
  if (!validTimestamp(document.retrievedAt) || typeof document.path !== "string" || typeof document.sha256 !== "string") {
    return false;
  }
  const verified = await verifyExistingFile(join(directory, document.path));
  return verified?.sha256 === document.sha256;
}

async function isReusable(
  directory: string,
  manifest: SourceManifest,
  record: StoredPreparedSource | null,
): Promise<boolean> {
  if (record === null || resolve(record.directory) !== directory || !sameManifest(record.manifest, manifest)) return false;
  if (!record.documents?.readme || !record.documents?.license) return false;
  if (record.documents.readme.path !== "README.md" || record.documents.license.path !== "LICENSE") return false;
  return (
    (await Promise.all(manifest.files.map((file) => sourceFileMatches(directory, file)))).every(Boolean) &&
    (await documentMatches(directory, record.documents.readme)) &&
    (await documentMatches(directory, record.documents.license))
  );
}

async function ensureSourceFile(
  directory: string,
  file: SourceFile,
  fetcher: typeof fetch,
): Promise<void> {
  if (await sourceFileMatches(directory, file)) return;
  const destination = join(directory, file.path);
  await downloadWithRetry(fixedSourceUrl(file.path), destination, file.sha256, file.bytes, fetcher);
}

async function prepareDocument(
  directory: string,
  path: string,
  fetcher: typeof fetch,
  retrievedAt: string,
): Promise<PreparedDocument> {
  const downloaded = await downloadWithRetry(fixedSourceUrl(path), join(directory, path), undefined, undefined, fetcher);
  return { path, sha256: downloaded.sha256, retrievedAt };
}

async function writePreparedRecord(directory: string, record: StoredPreparedSource): Promise<void> {
  const destination = join(directory, "prepared-source.json");
  const partial = `${destination}.partial`;
  await writeFile(partial, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await rename(partial, destination);
}

export async function prepareSourceWithManifest(
  directory: string,
  manifest: SourceManifest,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<PreparedSource> {
  const preparedDirectory = resolve(directory);
  await mkdir(preparedDirectory, { recursive: true });
  const recordPath = join(preparedDirectory, "prepared-source.json");
  const existing = await readPreparedRecord(recordPath);
  if (existing !== null && await isReusable(preparedDirectory, manifest, existing)) {
    return { directory: preparedDirectory, manifest, retrievedAt: existing.retrievedAt };
  }

  for (const file of manifest.files) await ensureSourceFile(preparedDirectory, file, fetcher);
  const retrievedAt = new Date().toISOString();
  const documents = {
    readme: await prepareDocument(preparedDirectory, "README.md", fetcher, retrievedAt),
    license: await prepareDocument(preparedDirectory, "LICENSE", fetcher, retrievedAt),
  };
  const result: StoredPreparedSource = { directory: preparedDirectory, manifest, retrievedAt, documents };
  await writePreparedRecord(preparedDirectory, result);
  return { directory: result.directory, manifest: result.manifest, retrievedAt: result.retrievedAt };
}

export async function prepareSource(
  directory: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<PreparedSource> {
  return prepareSourceWithManifest(directory, SOURCE_MANIFEST, fetcher);
}
