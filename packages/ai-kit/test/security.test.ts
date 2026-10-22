import { it, expect } from "vitest";
import {
  isPublicAddress,
  validateBaseURL,
  createSafeTransport,
} from "../src/server/network.js";
import {
  createAesGcmSecretProtector,
  createEnvironmentSecretProtector,
} from "../src/server/secrets.js";
import { AiKitError, sanitizeError } from "../src/server/errors.js";
import { randomBytes } from "node:crypto";
it.each([
  "127.0.0.1",
  "10.0.0.2",
  "169.254.169.254",
  "100.100.100.200",
  "100.64.0.1",
  "192.168.1.1",
  "0.0.0.0",
  "::1",
  "::ffff:127.0.0.1",
  "fc00::1",
  "fe80::1",
  "2001:db8::1",
  "198.18.0.1",
])("blocks non-public address %s", (ip) =>
  expect(isPublicAddress(ip)).toBe(false),
);
it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])(
  "accepts public address %s",
  (ip) => expect(isPublicAddress(ip)).toBe(true),
);
it.each([
  "http://api.example/v1",
  "https://key@api.example/v1",
  "https://api.example/v1?key=secret",
  "https://api.example/v1#secret",
  "https://127.0.0.1/v1",
  "https://2130706433/v1",
  "https://[::1]/v1",
  "https://api.example/v1/chat/completions",
  "https://api.example/v1/v1",
])("rejects unsafe SDK base URL %s", (url) =>
  expect(() => validateBaseURL(url)).toThrow(AiKitError),
);
it("preserves vendor path prefixes", () =>
  expect(validateBaseURL("https://open.bigmodel.cn/api/paas/v4/").href).toBe(
    "https://open.bigmodel.cn/api/paas/v4",
  ));
it("encrypts secrets bound to connection and refuses swapped envelopes", async () => {
  const p = createAesGcmSecretProtector(randomBytes(32).toString("base64"));
  const sealed = await p.seal("sensitive-key", "scope:c1");
  expect(sealed).not.toContain("sensitive-key");
  expect(await p.open(sealed, "scope:c1")).toBe("sensitive-key");
  await expect(p.open(sealed, "scope:c2")).rejects.toMatchObject({
    code: "CREDENTIAL_FAILURE",
  });
});
it("environment references require host allowlist", async () => {
  const p = createEnvironmentSecretProtector(["AI_DEMO_KEY"], (name) =>
    name === "AI_DEMO_KEY" ? "secret" : undefined,
  );
  expect(await p.open("env:AI_DEMO_KEY", "scope:c1")).toBe("secret");
  await expect(p.open("env:PATH", "scope:c1")).rejects.toMatchObject({
    code: "CREDENTIAL_FAILURE",
  });
  await expect(p.seal("plaintext", "scope:c1")).rejects.toMatchObject({
    code: "CREDENTIAL_SECURITY_REQUIRED",
  });
});
it("does not expose raw provider errors", () => {
  const err = sanitizeError(
    Object.assign(new Error("key secret URL https://secret"), {
      statusCode: 401,
      responseBody: "raw",
    }),
  );
  expect(err.code).toBe("AUTHENTICATION");
  expect(JSON.stringify(err)).not.toMatch(/secret|responseBody|https/);
});
it("rejects DNS containing any private address before fetch", async () => {
  await expect(
    createSafeTransport("https://api.example/v1", async () => true, {
      lookup: async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
    }),
  ).rejects.toMatchObject({ code: "UNSAFE_URL" });
});
it("blocks final URL changes and credential-bearing redirects", async () => {
  const t = await createSafeTransport(
    "https://api.example/v1",
    async () => true,
    {
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      fetch: async () =>
        new Response("", {
          status: 302,
          headers: { location: "https://evil.example" },
        }),
    },
  );
  try {
    await expect(
      t.fetch("https://evil.example/v1/chat/completions", {}),
    ).rejects.toMatchObject({ code: "UNSAFE_URL" });
    await expect(
      t.fetch("https://api.example/v1/chat/completions", {}),
    ).rejects.toMatchObject({ code: "UNSAFE_URL" });
  } finally {
    await t.close();
  }
});
it("limits declared and undeclared provider response bytes", async () => {
  for (const declared of [true, false]) {
    const t = await createSafeTransport(
      "https://api.example/v1",
      async () => true,
      {
        lookup: async () => [{ address: "8.8.8.8", family: 4 }],
        fetch: async () =>
          new Response("x".repeat(100), {
            headers: declared ? { "content-length": "100" } : {},
          }),
      },
      64,
    );
    try {
      if (declared)
        await expect(
          t.fetch("https://api.example/v1/chat/completions", {}),
        ).rejects.toMatchObject({ code: "OUTPUT_LIMIT" });
      else
        await expect(
          (await t.fetch("https://api.example/v1/chat/completions", {})).text(),
        ).rejects.toMatchObject({ code: "OUTPUT_LIMIT" });
    } finally {
      await t.close();
    }
  }
});
