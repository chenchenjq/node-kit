# 01 — 包脚手架与导出边界

Status: ready-for-agent

创建 `packages/sku-kit` 私有 ESM workspace，采用 Node `>=22.22.1 <23`、TypeScript strict/NodeNext、Vitest，并登记 `PACKAGES.md`。建立 `.`、`./server`、`./postgres`、`./client`、`./react`、`./testing` 六个出口；`server/postgres/testing` 配置 browser-forbidden，React 入口使用 `"use client"`。加入 build/typecheck/test 基线与资产复制脚本，但不实现业务逻辑。

验收：六入口从源码和 dist 的导出一致；核心和浏览器入口不引入 pg/Drizzle/server-only 运行时代码；服务端入口误入浏览器构建会失败。

Depends on: none

## Comments
