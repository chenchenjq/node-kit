# 10 — Next.js 示例、verify-pack 与文档

Status: done

仓库内 playground 示例（粘贴→解析→候选/警告→手工修正→模式切换→重组预览→确认交宿主；默认只填空项、歧义不预选、换区域清下级）。`scripts/verify-pack.mjs`：tgz→仓库外干净宿主→类型/入口/快照注入/断网运行/无 area-kit tsc 通过。文档：README.md、DATABASE.md（PG Drizzle 示例）、AI-USAGE.md（真实导出+复用提示词+实测容量+未验证清单）、CONTEXT.md+CONTEXT-MAP 登记、PACKAGES.md 更新。

## Comments

- playground：`examples/next/`（无 `package.json`，随 tgz 分发给宿主复制）。粘贴 → 解析 → 候选/警告 → 手工修正 → 模式切换 → 重组预览 → 确认交宿主；
  三条规则落地并可证：默认只填空项（非空字段需勾选“确认覆盖已有非空字段”）、歧义不预选（候选编号列表 + 无默认选中）、换区域清下级（`applyRegion` 只清空更深层级，同级分组与行政槽位互斥）。
  行为规则的单测证据：`test/example-edit.test.ts`（11 项）。浏览器点击未验证，见 AI-USAGE 的未验证清单。
- `scripts/verify-pack.mjs`：`npm pack` → 仓库外干净宿主（不安装 area-kit）→ tgz 清单/私有性、双入口与越界导入、
  文档示例编译、宿主 `tsc`、注入快照的解析断言、`next build` 负例、`next start` 端到端 HTTP（401/解析/跨区域/陈旧名称/伪造版本/超长/限流 429）、
  初始化后断网守卫下重复同样检查、`export-snapshot` 由宿主 Provider 驱动。通过后会回收宿主工作区（失败时保留排查）。
- 文档：`README.md`（5 段可编译示例）、`DATABASE.md`（`recipient_address` 列/类型/可空/索引/编码 + Drizzle 示例，手机号不唯一、`withStreet` 存储、`withoutStreet` 视图、名称快照不回写、解析建议与确认分离）、
  `AI-USAGE.md`（真实导出 + 复用提示词原文 + 实测容量 + 未验证清单）、`examples/next/README.md`、`CONTEXT.md`，并登记 `CONTEXT-MAP.md` 与 `PACKAGES.md`。
- 回归（2026-09-19，本机 Node v22.22.2 / linux-x64）：`npm run typecheck`（主 + examples 两套配置）0 error；`npm run build` 通过；
  `npm test` 77/77；`npm run test:integration` 9/9（真实 area-kit + PostgreSQL）；`node scripts/verify-pack.mjs` 14 步全绿（186 s），
  tgz SHA-256 `b35796bf6e9a6b50555a548e52871182568cd247846a9a548f23afc8c2240525`，证据在 `packages/addr-parse-kit/artifacts/pack-verification.json`。
- 未做（按约束）：不提交、不推送、不发布、不执行生产迁移；宿主侧接入事项见交付说明。
