# 08 — area-kit 适配器参考实现 + 快照导出

Status: done

`examples/area-kit-provider.ts`：listRegions 分页全量拉取（实测冷启动耗时入报告）+ 预导出 JSON 快照注入（datasetId/version 校验）。`scripts/export-snapshot.mjs`（调 area-kit 公开 API 导出）。不作包公开导出、不依赖 area-kit 内部源码/DB 实例。

## 完成记录

- `examples/area-kit-provider.ts`
  - `createAreaKitProvider({ kit, ctx, levels?, pageSize?, aliases?, onProgress? })`：`getDataset` 校验数据集存在且 `status==="ready"` → `listRegions({level:1})` 取省 → 逐省 `listRegions({ancestorCode, level:2..4})` 游标分页（pageSize 上限 200，越界直接 RangeError）→ 结构化类型 `AreaKitReadLike` 描述 area-kit 公开读接口，**不 import area-kit**，因此 tgz 宿主无 area-kit 也能通过 tsc。
  - 名称取宿主 `label`（宿主显示名参与匹配），原始名保留在 `sourceName`；`nodeKind` 原样带出，group 节点保留在快照里作父级链，不静默删节点（删了会让子节点父级缺失）。
  - 失败路径全部显式抛错：数据集不存在（VERSION_UNAVAILABLE 透传）、状态非 ready、`hasMore` 但 `nextCursor===null`、空快照。没有任何回退分支。
  - `validatePath` 走 area-kit `getPath` 的真实祖先链（loadSnapshot 成功后记住 datasetId/versionCode；未加载时直接判失败），跨分支归因到非祖先代码。
  - `stats()` 暴露 `{nodes, requests, coldStartMs}` 供宿主写入性能报告。
  - `createJsonSnapshotProvider({ file })`：离线快照模式，读文件一次后缓存；版本不一致时**按快照真实身份返回**，由核心抛 `E_REGION_VERSION_MISMATCH`（不在适配层静默换数据）。
  - `parseRegionSnapshot(unknown)`：快照结构校验（代码唯一、level 1..5、parentCode 类型、kind 白名单、aliases 字符串数组）。
- `scripts/export-snapshot.mjs`：与原设想的偏差——脚本**不直连 area-kit**，而是 `--provider <宿主模块>` 注入任意 RegionProvider（default 导出或其工厂函数），`--dataset-id/--version` 必填，导出前做代码唯一性 + 父级闭合校验，空快照拒绝导出。这样脚本可随 tgz 分发、不引入 area-kit 依赖，也不读写数据库、不打印任何收件信息。
- 真实 area-kit 实例对 `AreaKitReadLike` 的可赋值性（编译期证明）留到 09 的 PostgreSQL 集成测试里做：那才是唯一能同时拿到 area-kit 已构建 d.ts 与真实数据集的地方。

## 验证

- `npm run typecheck/test/build --workspace packages/addr-parse-kit`：typecheck 0 error，build 通过，测试 54/54 通过（`test/core.test.ts` 33 + `test/adapter.test.ts` 21）。
- `test/adapter.test.ts` 覆盖：1..4 级分页拉全（含第 5 级被排除、pageSize=3 的多页游标、requests 计数与 stats 一致）、label/sourceName 语义、别名注入、levels 截断、levels/pageSize 参数拒绝、数据集不存在/未就绪/游标缺失三类显式失败、适配 Provider 直接 `initParser` 端到端解析（广东省深圳市南山区粤海街道 + 收件人）、`E_REGION_INIT` 包装、`validatePath` 四态、JSON 快照离线解析/版本冲突/父级缺失（`E_SNAPSHOT_INVALID`）、`parseRegionSnapshot` 结构拒绝、export-snapshot 脚本正反向（子进程真跑）。
- 冷启动实测耗时属于 09（需要真实 area-kit + PG），当前只完成结构与契约验证。
