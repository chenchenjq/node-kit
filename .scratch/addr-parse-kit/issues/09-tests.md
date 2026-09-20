# 09 — 测试：fixtures/单测/裁剪快照集成/性能脚本

Status: done

fixtures 小快照（直辖市 group/省直辖县级/跳层/重名区县/重名街道）；单测覆盖 gap-report 用例 + Prompt §8 清单 + 核心回归组；Testcontainers PG 集成（area-kit CLI 导入裁剪 CSV→真实 Provider→SDK 全链路，未跑通不得声称"真实集成"）；人工标注集与合成样例分目录；bench 脚本 1 千/1 万档（吞吐/p50/p95/p99/内存/事件循环，10 万档标未验证）。

## 完成记录

**fixtures**（`test/fixtures.ts`）：60 节点真实区划代码小快照，刻意包含直辖市二级分组（1101/3101/5001 市辖区）、
省直辖县级跳层（42 湖北省 → 4290 省直辖县级行政区划 → 429004 仙桃市）、三级重名区县（410204/320106/320302 鼓楼区）、
同名市辖区链（4419 东莞市 → 441900 东莞市）、省级别名（内蒙古自治区/内蒙古）、第 5 级统计单元（440305007001 科技园社区）。
`countLevels()` 供适配器完整性校验用真实分级行数。

**单元测试**：`test/core.test.ts` + `test/adapter.test.ts`，共 66 例（`npm test`，含 10 例样例评测），全绿。

**PostgreSQL 真实链路**（`npm run test:integration`，9/9 全绿）：Testcontainers 起固定摘要版本的 postgres（tmpfs、
一次性 schema、子进程环境剥离宿主 PG 变量），真实 `createDrizzleAreaStore` + `areaMigrationSql(schema)` + 公开
`activateDataset` + `createAreaKit`，再用真实 `AreaKit<Ctx>` 实例满足适配器的结构化 `AreaKitReadLike<Ctx>`（编译期证明），
跑通「宿主区域数据 → 适配器分页拉全 → SDK 索引 → 解析」全链路。含跳层丢节点必须被完整性校验拦下、第 5 级不进索引、
不存在第二套区划数据（江苏省南京市玄武区… 只能到市级，玄武区留在详细地址与残差里）等断言。
测得冷启动（60 节点合成集，不代表生产规模）：`nodes=60 requests=39 coldStartMs=360`。

> 与 Prompt 的偏差（沿用 08 已记录的结论）：area-kit CLI 的 `import` 会校验 `SOURCE_MANIFEST` 校验和，裁剪过的 CSV
> 无法经 CLI 导入，因此集成测试直接按 area-kit 的表结构灌入裁剪快照并调用公开 `activateDataset`，
> 仍然走真实 store/读接口/CLI 之外的同一套服务端代码。

**样例评测（分目录）**
- `test/samples/annotated/`：31 例人工标注（`ANNOTATION-RULES.md` 写明标注人、隐私约束、判定口径），
  基准是 `fixture-ds/fixture-v1` 这 60 节点快照。指标：状态判定 17/17、复核标记 24/24、候选条数 15/15、
  字段识别（province/city/district/street/regionGroup）各 27/27、完整路径 27/27、收件人字段 19/19、
  关键内容保留 68/68、警告码 11/11、调用错误按预期抛出 1/1，失败明细 0 条。
- `test/samples/synthetic/`：500 例固定种子合成样例，只用于压结构性不变量，**不产出准确率结论**；
  实测 门牌要素保留 500/500、代码均来自宿主快照 500/500、显式命中可在原文定位 500/500、
  推断层级带警告 500/500、推断层级需复核 500/500。
- 评测报告只打印编号/代码/计数，不打印地址原文、姓名与号码。
- **必须连同数字一起读的限制**：标注由本包实现者自己编写，样本量 31 条，且区域覆盖只有 60 节点小快照。
  这些 100% 是「行为回归基线」，不是真实数据上的准确率；真实数据准确率、真实快照冷启动一律标未验证。

**评测反过来抓出的 3 个真实缺陷（已修）**
1. `rebuildText` 把整段原文的绝对区间用到 `raw.slice(tailStart)` 上，导致详细地址按错误偏移削字符
   （表现为电话尾数被吃掉，如 `13300005555` → `1330000555`）。现在平移 `tailStart` 后再裁剪。
2. 电话正则没有数字边界，19 位订单号/18 位身份证号里的片段被当成手机号（还只保留 11 位，等于丢信息）。
   现在加 `(?<!\d)…(?!\d)`，并把「转/分机/ext/x」扩展号从主号码里剥离为 `phoneExtension`。
3. 引擎偶尔把标签词（"身份证"）或备注句子（"备注：放驿站，周末勿送"）当成姓名。现在标签词/区域名/行政区后缀
   一律不写入 `recipient.name`（给 `NAME_MAY_BE_PLACE`），备注句内的片段同样不采信，
   无标签时改用「电话前紧邻中文」启发式并明确标 `RECIPIENTS_AMBIGUOUS` + 需复核；原文片段一律留在详细地址里。

**性能脚本**（`scripts/bench.mjs`，报告落盘 `.scratch/addr-parse-kit/bench/scale-proxy.json`）
数据构成：31 省 × 11 市 × 9 区县 × 13 街道 = 43338 个 1..4 级**合成**节点（名称人造），
地址文本同样合成（15% 缺省、25% 带收件人标签、含订单号/备注噪声）。环境：Node v22.22.2、linux/x64、
Intel i5-7300HQ（4 逻辑核）、19.4 GiB 内存。实测：

| 指标 | 1 千条 | 1 万条 |
| --- | --- | --- |
| 冷启动（首次 `initParser`，含索引 + SDK 构建） | 1309ms，RSS +45.5MiB / heap +38.5MiB（43338 节点） | 同一次进程内仅发生一次 |
| 第二次 `initParser` 同 `source|datasetId|version` | 0ms，provider 不再被调用 | 同左 |
| 总耗时 / 吞吐 | 1332ms / 751 条·s⁻¹ | 10700ms / 935 条·s⁻¹ |
| 单条 p50 / p95 / p99 / max | 1.146 / 2.488 / 4.450 / 7.319 ms | 0.992 / 1.330 / 3.279 / 42.559 ms |
| 每 100 条让出一次时的事件循环停顿 p50 / p99 / max | 128.0 / 213.8 / 213.8 ms | 100.3 / 164.0 / 166.6 ms |
| `parseBatch`（100 条分片，1 万条） | — | 11111ms，RSS +18MiB，成功 10000/10000 |
| 进程 RSS 峰值 | 184.1MiB | 186.2MiB |

读数：解析是同步 API，一次请求里解析 100 条就会让该进程停顿约 100–210ms，所以高并发必须分片或放独立工作进程。
「需人工复核占比 ≈52%」是合成集人造街道名重名密度过高造成的，不能读作真实歧义率。

**未验证（不得被省略）**
- 真实权威快照（66.5 万行含村级）下的冷启动与内存：本机离线，未下载。
- 10 万条/批与更高并发下的吞吐与延迟：未在真实数据上跑。
- 多进程/worker 共享索引的收益：未测。
- 线上真实流量干扰（GC、连接争用）下的表现：未测。
- 真实数据上的字段识别准确率：未测（合成集不产出准确率结论，标注集只是回归基线）。

## 验证

- `npm run typecheck` 0 error；`npm run build` 通过。
- `npm test`：66/66（`test/core.test.ts`、`test/adapter.test.ts`、`test/samples.test.ts`）。
- `npm run test:integration`：9/9（真实 area-kit + PostgreSQL + SDK 全链路）。
- `node scripts/bench.mjs --levels 1000,10000 --json ../../.scratch/addr-parse-kit/bench/scale-proxy.json` 跑通并落盘。
