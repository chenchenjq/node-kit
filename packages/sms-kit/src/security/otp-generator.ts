import { randomInt } from "node:crypto";

export class OtpGenerator {
  generate(length = 6): string {
    const ceiling = 10 ** length;
    return randomInt(0, ceiling).toString().padStart(length, "0");
  }
}
