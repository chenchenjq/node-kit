# Context Map

This repository is an npm monorepo. Each package is an independent domain context; read the relevant package context before changing its code.

| Context | Package path | Context document |
| --- | --- | --- |
| AI capabilities | `packages/ai-kit/` | `packages/ai-kit/CONTEXT.md` |
| Authentication | `packages/auth-kit/` | `packages/auth-kit/CONTEXT.md` |
| Object storage | `packages/oss-kit/` | `packages/oss-kit/CONTEXT.md` |
| Area data | `packages/area-kit/` | `packages/area-kit/CONTEXT.md` |
| Address parsing | `packages/addr-parse-kit/` | `packages/addr-parse-kit/CONTEXT.md` |
| SMS delivery | `packages/sms-kit/` | `packages/sms-kit/CONTEXT.md` |
| SKU configuration | `packages/sku-kit/` | `packages/sku-kit/CONTEXT.md` |

System-wide architectural decisions belong under `docs/adr/`. Package-specific decisions belong under the package's `docs/adr/` directory.
