import { describe, expect, it } from "vitest";
import {
  hashPassword,
  validatePassword,
  verifyPassword,
} from "../src/server/password.js";

describe("password service baseline", () => {
  it("validates password complexity (8-128 chars, letter + digit)", () => {
    expect(() => validatePassword("abc12345")).not.toThrow();
    expect(() => validatePassword("Password123!")).not.toThrow();
    expect(() => validatePassword("short1")).toThrow("8–128");
    expect(() => validatePassword("alllettersnomumber")).toThrow("8–128");
    expect(() => validatePassword("1234567890")).toThrow("8–128");
    expect(() => validatePassword("a".repeat(129))).toThrow("8–128");
  });

  it("hashes password using argon2id with fixed cost parameters", async () => {
    const hash = await hashPassword("ValidPass123");
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=65536,p=1,t=3\$/);

    const match = await verifyPassword({
      hash,
      password: "ValidPass123",
    });
    expect(match).toBe(true);

    const wrong = await verifyPassword({
      hash,
      password: "WrongPassword123",
    });
    expect(wrong).toBe(false);
  });

  it("verifyPassword rejects non-argon2id hashes without throwing", async () => {
    expect(
      await verifyPassword({
        hash: "$2a$10$abcdefghijklmnopqrstuvwxyz123456",
        password: "test",
      })
    ).toBe(false);
    expect(
      await verifyPassword({
        hash: "plain-text-hash",
        password: "test",
      })
    ).toBe(false);
  });
});
