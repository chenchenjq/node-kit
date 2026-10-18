import { hash, verify, argon2id } from "argon2";

export function validatePassword(password: string): void {
  if (
    typeof password !== "string" ||
    password.length < 8 ||
    password.length > 128 ||
    !/[a-z]/i.test(password) ||
    !/[0-9]/.test(password)
  ) {
    throw new Error("新密码须为 8–128 个字符，包含英文字母和数字");
  }
}

/** Use for first-time credential preparation; importing an existing hash must not call this. */
export async function hashPassword(password: string): Promise<string> {
  validatePassword(password);
  return hash(password, {
    type: argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
  });
}

/** Login verification deliberately does not apply new-password policy. */
export async function verifyPassword(input: {
  hash: string;
  password: string;
}): Promise<boolean> {
  if (
    !input.hash ||
    typeof input.hash !== "string" ||
    !input.hash.startsWith("$argon2id$")
  ) {
    return false;
  }
  try {
    return await verify(input.hash, input.password);
  } catch {
    return false;
  }
}
