# 01 — 包脚手架与构建约定

Status: done

按仓库约定创建 `packages/addr-parse-kit`：package.json（private、type=module、exports `.`/`./server`、engines `>=22.22.1 <23`、依赖 address-smart-parse 4.0.3）、tsconfig.build.json（继承 base）、vitest.config.ts、`browser-forbidden` stub、登记 PACKAGES.md。验证 `npm run build/typecheck/test --workspace`。

## Comments

- 完成证据：构建、typecheck、双入口解析均通过；`dist/browser-forbidden.js` 的 `browser` 条件在打包验收里被证明能被 `next build` 拒绝。tgz 清单禁止 test/artifacts/node_modules/.npmrc/.env 与 `.csv|.jsonl|.pem|.key`。
