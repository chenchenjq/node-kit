# 01 — 包脚手架与构建约定

Status: done

按仓库约定创建 `packages/addr-parse-kit`：package.json（private、type=module、exports `.`/`./server`、engines `>=22.22.1 <23`、依赖 address-smart-parse 4.0.3）、tsconfig.build.json（继承 base）、vitest.config.ts、`browser-forbidden` stub、登记 PACKAGES.md。验证 `npm run build/typecheck/test --workspace`。

## Comments

- 完成证据：构建、typecheck、双入口解析均通过；`dist/browser-forbidden.js` 的 `browser` 条件在打包验收里被证明能被 `next build` 拒绝。tgz 清单禁止 test/artifacts/node_modules/.npmrc/.env 与 `.csv|.jsonl|.pem|.key`。
- 2026-09-21 补 spec §依赖“保留 SDK LICENSE 说明”：新增 `licenses/address-smart-parse.LICENSE.txt`（`address-smart-parse@4.0.3` 的 ISC 原文，逐字复制自依赖包内 `LICENSE`），
  `files` 加入 `licenses` 使其随 tgz 分发；README 新增“许可证与第三方声明”一节，写明上游 README 要求商业项目另行联系作者确认，且 **Q7a 确认函未发出、未获答复，不得宣称已取得商用授权**；
  AI-USAGE 未验证清单同步登记。`verify-pack.mjs` 的清单步骤新增两条断言：tgz 必须包含该许可文件，且包内文本与 `require.resolve("address-smart-parse/package.json")` 同级的 `LICENSE` 逐字一致。
  复跑证据见 issue 10（14 步全绿，`npm test` 77/77，typecheck 两套配置 0 error）。
- Q7a 发函草稿已备好：`../q7a-author-confirmation-draft.md`（含待确认清单 6 条、可直接改用的正文、收到答复后要做的三件事）。仍为未发出状态，需人工审阅后经作者提供的渠道发送。
