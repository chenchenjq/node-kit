# Source recovery baseline

The original editable auth-kit source and test suite were not present in this repository or its available Git history. The tracked `dist` files and the archived `0.0.0` package matched byte-for-byte. This recovery copies the readable JavaScript and declaration files from that verified `dist` into `src` and makes `src` the build input.

`npm run build` now copies those authored files back to `dist`. The first rebuilt `dist` matched every archived JavaScript and declaration byte. `README.md`, `AI-USAGE.md`, and the examples were restored from the same archive. Future fixes must edit `src`, rebuild, and keep declarations aligned with the public API.

The baseline tests cover the public exports, schema generation, password hash/verify, client request paths and errors, and an unauthenticated server error path. They do not prove successful database-backed authentication or SMS delivery; those require the host integration and real persistence tests in subsequent work. The original TypeScript source, original test intent, and any unpublished history cannot be recovered from the available archive.

The rebuilt tarball also loaded its server, React, and schema public entries from a separate temporary consumer directory. That smoke test reused the workspace's installed dependency tree. A fully fresh offline `npm install` could not resolve uncached Better Auth package metadata, so clean-registry installation remains a release check.
