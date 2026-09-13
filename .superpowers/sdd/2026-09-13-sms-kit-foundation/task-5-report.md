# Foundation Task 5 Report — Security Primitives

## Scope

Implemented the `sms-kit` environment-secret resolver, HMAC-SHA-256 hasher,
and AES-256-GCM payload/phone protectors. The public security barrel exports
the concrete implementations and the AES keyring contract.

## TDD evidence

1. Added the focused resolver and protector tests before production code. The
   tests name the failures they guard: unapproved/empty environment references,
   invalid HMAC keys and mismatched values, plaintext leakage into persisted
   outputs, invalid AES keys, altered ciphertext, wrong key material, unknown
   key IDs, and tenant/message/field context swaps.
2. RED command:

   ```sh
   npm test --workspace sms-kit -- test/unit/security
   ```

   Result: exited 1 with 2 test files and 8 failing tests. The failures were
   expected missing concrete exports (for example,
   `EnvSecretResolver is not a constructor` and
   `AesGcmMessagePayloadProtector is not a constructor`).
3. Added only the tested resolver, HMAC implementation, AES-GCM envelope
   implementation, exports, and the Node declaration-build type configuration.
   The build-config adjustment was separately reproduced RED with
   `npm run build --workspace sms-kit`: Node types were installed and used by
   the regular typecheck, but omitted by `tsconfig.build.json`, which caused
   `node:crypto` and `Buffer` declaration errors. Adding `types: ["node"]`
   restored declaration building without adding a dependency.
4. GREEN verification:

   ```sh
   npm test --workspace sms-kit -- test/unit/security
   npm run typecheck --workspace sms-kit
   npm run build --workspace sms-kit
   ```

   Result: all commands exited 0. Vitest reported 2 files and 9 tests passed;
   typecheck and declaration build completed without diagnostics.

## Changed files

- `packages/sms-kit/src/security/env-secret-resolver.ts`
- `packages/sms-kit/src/security/hmac-hasher.ts`
- `packages/sms-kit/src/security/aes-gcm-protector.ts`
- `packages/sms-kit/src/security/index.ts`
- `packages/sms-kit/test/unit/security/env-secret-resolver.test.ts`
- `packages/sms-kit/test/unit/security/protectors.test.ts`
- `packages/sms-kit/tsconfig.build.json` — enables the already-installed Node
  declarations for the server-only security entry’s emitted declarations.

## Security self-review

- The resolver accepts only strict `env://UPPERCASE_NAME` references, reads the
  injected environment on demand, does not cache or log values, and maps
  malformed, missing, and blank references to a constant `SECRET_UNRESOLVABLE`
  error without including the reference or value.
- HMAC keys are supplied separately from the AES keyring and must be 32 bytes.
  HMAC output is base64url SHA-256; malformed hashes return `false`, while
  valid candidates are checked with `timingSafeEqual`.
- AES keys must be exactly 32 bytes. Encryption uses a fresh 96-bit IV,
  AES-256-GCM authentication tags, and a versioned base64url envelope. The AAD
  authenticates the exact tuple of envelope version, key ID, purpose, tenant,
  record ID, and field name.
- Decryption strictly parses canonical envelope encodings, requires the stored
  key ID to resolve, and maps malformed data, unknown keys, wrong key material,
  GCM authentication failures, and context swaps to a constant
  `STORAGE_FAILURE` error. Error messages contain no ciphertext, keys, phone
  value, template values, or environment values.
- Phone persistence output is limited to ciphertext, key ID, keyed lookup
  hash, masked form, and last four digits. Payload values and complete phone
  values exist only transiently for encryption/decryption and are never logged
  or persisted by these primitives.
- `git diff --check` was clean. Only the scoped Task 5 source, tests, required
  declaration-build configuration, and this report are staged; pre-existing
  untracked dependency/build directories remain excluded.

## Commit

`feat: protect sms secrets and sensitive payloads`

## Fix round 1 — Authenticated-inner-envelope tamper coverage

### Requirement addressed

Replaced the authentication-relevant portion of tamper coverage with a focused
test that decodes a sealed outer base64url envelope, flips one bit in its
16-byte inner GCM tag, then serializes the same envelope shape back to
canonical base64url before calling `open()`.

### TDD evidence

1. Added `rejects a canonical envelope with a modified GCM authentication tag`
   before changing production behavior. The test uses a real protector and
   real AES-GCM output; it makes no assertions about mocks or implementation
   text.
2. To prove this test reaches the authentication finalization path rather than
   only envelope parsing, temporarily removed `decipher.final()` after the
   test was in place. RED command:

   ```sh
   npm test --workspace sms-kit -- test/unit/security/protectors.test.ts -t "canonical envelope"
   ```

   Result: exited 1. The test failed because `open()` resolved
   `{ order: "A-100" }` instead of rejecting, demonstrating that an omitted
   GCM final/authentication check is detected by this canonical-envelope test.
3. Restored `decipher.final()`; no production behavior change was needed
   because the implementation was already correctly authenticating the tag.
   GREEN verification:

   ```sh
   npm test --workspace sms-kit -- test/unit/security
   npm run typecheck --workspace sms-kit
   ```

   Result: both commands exited 0. Vitest reported 2 files and 10 tests
   passed; typecheck completed without diagnostics.

### Security self-review

- The altered tag remains a correctly sized, canonical base64url field inside
  a syntactically valid version-1 envelope, so parsing and envelope validation
  cannot be the reason for rejection.
- The RED mutation caused decryption update output to deserialize as the
  original payload; only `decipher.final()` detects the altered GCM tag. This
  demonstrates the test exercises authenticated decryption rather than a
  parser-only failure path.
- The final implementation still maps the authentication failure to the
  stable, non-sensitive `STORAGE_FAILURE` error.
