import OSS from "ali-oss";
import type { Readable } from "node:stream";
import type { Credentials, StorageSummary } from "../types.js";
export interface OssTransport {
  put(key: string, body: Buffer, mimeType: string, privateAccess: boolean): Promise<void>;
  get(key: string): Promise<Buffer>;
  read(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
  sign(key: string, expiresInSeconds: number): Promise<string>;
}
/** OSS network seam for integration tests/instrumentation, not a cloud-provider abstraction. */
export type OssTransportFactory = (storage: StorageSummary, credentials: Credentials, options: { timeoutMs: number; browser: boolean }) => OssTransport;
export const createAliyunTransport: OssTransportFactory = (storage, credentials, options) => {
  const browserDomain = options.browser ? storage.publicDomain : null;
  const client = new OSS({
    region: storage.region, bucket: storage.bucket,
    endpoint: options.browser ? browserDomain ?? `https://${storage.region}.aliyuncs.com` : storage.endpoint,
    ...(browserDomain ? { cname: true } : {}),
    ...credentials, secure: true, authorizationV4: true, timeout: options.timeoutMs,
  });
  // ali-oss 6.23.0 has no retryMax in @types; omission disables retries (SDK default).
  return {
    async put(key, body, mimeType, privateAccess) {
      await client.put(key, body, { timeout: options.timeoutMs, mime: mimeType, headers: { "x-oss-forbid-overwrite": "true", ...(privateAccess ? { "x-oss-object-acl": "private" } : {}), "Content-Disposition": "attachment" } });
    },
    async get(key) { return (await client.get(key)).content; },
    async read(key) { return (await client.getStream(key)).stream; },
    async delete(key) { await client.delete(key); },
    async sign(key, expires) { return client.signatureUrlV4("GET", expires, {}, key); },
  };
};
