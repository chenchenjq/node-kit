import { expect, it } from "vitest";
import { createAesGcmCredentialProtector } from "../src/server/credentials.js";
import { credentials } from "./helpers.js";
it("rejects bad keys, tampering and wrong decryption keys without disclosing inputs", async () => {
  expect(() => createAesGcmCredentialProtector("bad-secret-key")).toThrow();
  const a = createAesGcmCredentialProtector(Buffer.alloc(32, 1).toString("base64")), b = createAesGcmCredentialProtector(Buffer.alloc(32, 2).toString("base64"));
  const envelope = await a.seal(credentials);
  expect(await a.open(envelope)).toEqual(credentials); expect(envelope).not.toContain(credentials.accessKeySecret);
  await expect(b.open(envelope)).rejects.toMatchObject({ code: "CREDENTIAL_FAILURE" });
  await expect(a.open(envelope + "x")).rejects.toMatchObject({ code: "CREDENTIAL_FAILURE" });
  const parts = envelope.split(".");
  parts[2] = Buffer.from(parts[2]!, "base64url").subarray(0, 4).toString("base64url");
  await expect(a.open(parts.join("."))).rejects.toMatchObject({ code: "CREDENTIAL_FAILURE" });
  await expect(a.open(envelope + ".")).rejects.toMatchObject({ code: "CREDENTIAL_FAILURE" });
  expect(await a.seal(credentials)).not.toBe(envelope);
});
