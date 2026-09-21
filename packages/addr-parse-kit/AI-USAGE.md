# AI 接入约束（addr-parse-kit）

给编码代理/自动化改动用的单一事实页。生成任何地址相关改动前先读本页与 `README.md`、`DATABASE.md`，
并确认宿主**实际存在**的区域 Provider 与数据版本；本页只列已实现导出，未列出的能力一律视为不存在。

## 复用提示词（引用原文）

> 先确认宿主区域 Provider 与数据版本，仅使用 addr-parse-kit 公开 API；不再引入一套地址数据，不猜测代码或层级，不取候选第一条冒充确定结果。按业务指定是否输出街道，隐藏的街道信息并入详细地址；保留门牌房号，区分解析建议与确认结果。已有地址覆盖需确认，不把解析分数当作可配送证明，不向外部服务发送收件原文。

## 公开导出（与实现一致）

| 模块 | 导出 | 运行位置 |
| --- | --- | --- |
| `addr-parse-kit` | 类型：`AdminLevel` `NodeKind` `MatchKind` `ParseStatus` `OutputMode` `WarningCode` `ParseWarning` `LevelNode` `Recipient` `AddressMeta` `AddressCandidate` `ParseResult` `ParseOptions` `BatchItem` `ParseLimits` `RegionNode` `RegionSnapshot` `PathProblem` `PathCheck` `RegionProvider`；函数：`formatAddress` `formatRecipientLine` `toWithStreet` `toWithoutStreet` `validateAddressIntegrity` | 服务端 + 浏览器 |
| `addr-parse-kit/server` | `initParser` `ParseKitError` `DEFAULT_LIMITS`，以及 `AddrParser` `InitParserOptions`（并透传上面全部类型） | 仅服务端 |

**本包没有 React/客户端导出**：没有 `addr-parse-kit/react`、没有 `addr-parse-kit/client`。
UI 由宿主实现，可复制 `examples/next/app/page.tsx` 与 `examples/next/lib/{edit,protocol,provider,host,http}.ts` 作为起点
（这些示例文件不是公开 API，宿主改完自负其责）。`./server` 在浏览器条件下指向抛错护栏模块，
客户端组件里导入它会在构建期失败——不要用例外包一层 try/catch 绕过。

## 宿主需要改的文件

1. 服务端模块：`initParser({ provider, datasetId, version, limits })`，Provider 由宿主区域数据适配
   （参考 `examples/area-kit-provider.ts` 的 `createAreaKitProvider` / `createJsonSnapshotProvider`）。
2. 数据集钉版配置：`datasetId`/`version` 来自宿主可信配置，不从请求读取；换版本 = 改配置 + 重新初始化。
3. HTTP 适配层：认证、限流、请求体形状校验、错误码→HTTP 状态映射；收件原文只走 POST 请求体。
4. 前端表单：候选列表（不预选）、手工修正、模式切换、重组预览、覆盖确认、确认提交。
5. 落库：迁移与表由宿主拥有，见 `DATABASE.md`；确认动作单独成列（`confirmed_at`）。
6. 日志：默认不输出收件原文、姓名、号码（`ParseResult.input` 含原文）。

## 参数 / 返回 / 错误码 / 默认值

`initParser(options)` → `Promise<AddrParser>`：`provider`（`source` + `loadSnapshot` + `validatePath`）、
`datasetId`、`version` 必填，`limits` 为 `Partial<ParseLimits>`，与 `DEFAULT_LIMITS` 合并：
`{ maxTextLength: 4096, maxBatchSize: 100, maxCandidatesDefault: 5, maxCandidatesHardCap: 20 }`。
返回实例暴露 `meta`（`parserVersion`/`sdkVersion`/`regionSource`/`datasetId`/`regionVersion`/`codeScheme`）、`limits`、
`parse`、`parseBatch`、`validateSelection`。同 `provider.source|datasetId|version` 的索引进程内只构建一次。

`parse(text, options?)` → `ParseResult`：`{ input, status, requiresReview, warnings, candidates[], meta }`。
`options.extractRecipient`（默认 `true`）、`maxCandidates`（默认 5，取 `1..20`，越界抛错不钳制）、
`allowInferred`（默认 `false`）、`regionHint`（只剔除与原文明示区域冲突的候选，绝不覆盖原文）。
候选字段：`status ∈ matched|ambiguous|partial|unmatched`、`requiresReview`、`warnings[]`、
`province/city/district/street/regionGroup`（每级 `LevelNode`，`match ∈ explicit|inferred|none`，带 `matchedText`/`matchedRange`）、
`deepestLevel`、`detailedAddress`、`residualText`、`recipient`、`mode`、`confidence`、`scoreReasons`。

`parseBatch(texts, options?, recordIds?)` → `BatchItem[]`（`{index, recordId?, ok, result?, error?}`），逐条隔离失败。
`validateSelection(codes)` → `PathCheck`：只做结构校验（代码存在、层级递增、构成父子路径）；
父子关系的权威结论在宿主的 `provider.validatePath`，两者都过才允许落库。

| 错误码 | 触发 | 建议 HTTP |
| --- | --- | --- |
| `E_INPUT_TYPE` / `E_INPUT_EMPTY` | 非字符串 / 全空白 | 400 |
| `E_INPUT_TOO_LONG` | 超过 `limits.maxTextLength` | 413 |
| `E_MAX_CANDIDATES` | `maxCandidates` 非整数或不在 `1..maxCandidatesHardCap` | 400 |
| `E_BATCH_NOT_ARRAY` / `E_BATCH_TOO_LARGE` | 批量入参非数组 / 超 `maxBatchSize` | 400 |
| `E_REGION_INIT` | Provider 形状不符 / 快照加载失败 / 未显式给 datasetId+version | 503 |
| `E_REGION_VERSION_MISMATCH` | Provider 返回版本与请求不一致 | 503 |
| `E_SNAPSHOT_INVALID` | 快照残缺（空、重复代码、缺父级、层级非递增） | 503 |

`ParseKitError` 有 `code` 字段；把它映射成宿主错误码，不要把内部消息直接透给终端用户。

## 必须遵守的行为规则

- 多条候选时不取 `candidates[0]` 当作确定结果；宿主界面或流程必须让用户确认，`requiresReview` 只是排序信号。
- 层级留空就返回 `null`：不开 `allowInferred` 就不要自己补“省”，也不要为了填满表单猜代码。
- `regionHint`/用户手工修改都不能覆盖原文里明写的区域；冲突时保留原文结果并记 `HINT_CONFLICT`。
- 门牌、房号、楼层、备注必须留在 `detailedAddress`；隐藏街道时用 `toWithoutStreet` 把原文出现过的街道文本并回详细地址，不要静默删除。
- 换上级区域必须清空更深层级代码，禁止“新名称 + 旧代码”混排提交；提交前用 `validateSelection` + `provider.validatePath` 复核。
- 已有非空地址被解析结果覆盖前需要用户确认；`confidence` 高不代表可配送或地址真实存在。
- 不把收件原文写进 URL 查询参数、日志、埋点或任何外部服务请求；本包运行期无网络调用。
- 手机号不得作为收件记录的全局唯一键；号码列不加唯一约束。
- 宿主对外接口必须自带认证、限流、输入校验；本包的输入校验只防误用，不防攻击。

## 流程骨架

```typescript
import { initParser, ParseKitError, type AddrParser, type RegionProvider } from "addr-parse-kit/server";
import { toWithoutStreet, validateAddressIntegrity } from "addr-parse-kit";
import type { AddressCandidate } from "addr-parse-kit";

declare const provider: RegionProvider;
declare const log: (event: string, fields: Record<string, string | number | boolean>) => void;

export const parser: AddrParser = await initParser({
  provider,
  datasetId: "china-area",
  version: "2026Q1",
});

export async function suggest(raw: unknown): Promise<{ ok: true; candidates: AddressCandidate[] } | { ok: false; code: string }> {
  try {
    // 长度/类型校验宿主也要做一遍：这里的限额只防误用。
    const result = parser.parse(String(raw ?? ""));
    // 日志里只记长度与结论，绝不记原文/姓名/号码。
    log("addr.parse", { textLength: result.input.length, status: result.status, candidates: result.candidates.length, requiresReview: result.requiresReview });
    return { ok: true, candidates: result.candidates };
  } catch (error) {
    return { ok: false, code: error instanceof ParseKitError ? error.code : "E_INTERNAL" };
  }
}

/** 确认后的提交前检查：结构 + 区域路径 + 模式一致性，任一不过就不落库。 */
export async function readyToSave(
  candidate: AddressCandidate,
  codes: readonly (string | null)[],
): Promise<{ ok: boolean; problems: string[] }> {
  const path = await provider.validatePath(codes);
  const structural = parser.validateSelection(codes);
  const view = candidate.mode === "withoutStreet" ? toWithoutStreet(candidate) : candidate;
  const problems = [
    ...path.problems.map((p) => p.reason),
    ...structural.problems.map((p) => p.reason),
    ...validateAddressIntegrity(view).map((i) => `${i.field}: ${i.reason}`),
  ];
  return { ok: path.ok && structural.ok && problems.length === 0, problems };
}
```

批量：`parseBatch` 有 `maxBatchSize`（默认 100）上限，超出抛 `E_BATCH_TOO_LARGE`；
按 `parser.limits.maxBatchSize` 分片，逐条检查 `item.ok`，失败的按 `recordId` 回填给业务，不要整批丢弃。

## 部署与容量建议

- 解析是**同步 CPU 操作**：一次请求内解析上百条会占住该进程的事件循环。在线接口按条分片或放到独立工作进程/队列。
- 每个进程初始化一次（索引构建在进程内缓存，不跨进程共享）；容器横向扩容会重复付这份冷启动成本。
- 区域快照优先用预导出的 JSON（`scripts/export-snapshot.mjs`）或宿主已有的只读接口，不要在请求路径上现拉全量区域数据。
- 冷启动期间对初始化失败的请求返回 503（`E_REGION_INIT`），不要回退到任何内置数据。

实测容量（`node scripts/bench.mjs`，合成 1..4 级 43,338 个节点，Node v22.22.2 linux/x64，i5-7300HQ 4 核 19.4GiB，`address-smart-parse` 4.0.3）：

| 场景 | 结果 |
| --- | --- |
| 首次 `initParser`（建索引 + 引擎） | 1309 ms，RSS +45.5 MiB，Provider 加载 1 次 |
| 同键第二次 `initParser` | 0 ms，不再调用 `loadSnapshot` |
| 1000 条 | 1332 ms，751 条/秒，单条 p50 1.146 / p95 2.488 / p99 4.450 / max 7.319 ms |
| 10000 条 | 10700 ms，935 条/秒，单条 p50 0.992 / p95 1.330 / p99 3.279 / max 42.559 ms |
| `parseBatch` 10000 条（按 100 条分片） | 11111 ms，10000/10000 成功，RSS +18 MiB |
| 峰值 RSS | 约 184–186 MiB |
| 每百条事件循环停顿 | p50 约 100–128 ms，max 214 ms（这是在线接口必须分片的直接原因） |
| 端到端集成冷启动（宿主 Provider 参考实现，真实 area-kit 链路 + PostgreSQL） | `nodes=60 requests=39 coldStartMs=626`（测试用小快照，两次实测 360–626 ms，**不代表生产规模**） |

质量基线（同一测试集，非线上准确率）：31 条标注样例在 `matched/partial/ambiguous/unmatched` 上的字段级指标均为 100%，
500 条合成地址的结构性不变量（无吞字、span 可复原、模式往返）全部通过。单元测试 77 项（含 11 项 playground 行为断言，见 `test/example-edit.test.ts`）+ 集成测试 9 项。
打包验收 `node scripts/verify-pack.mjs` 在仓库外干净宿主（未安装 area-kit）跑通 14 项：tgz 清单、双入口、文档示例编译、宿主 `tsc`、
客户端越界导入被 `next build` 拒绝、注入快照的解析/错误码断言（进程级断网守卫下零外部连接）、示例站点构建、
`next start` 端到端 HTTP（401 / 解析 / 跨区域拒绝 / 陈旧名称拒绝 / 伪造版本拒绝 / 超长 413 / 限流 429）、断网重启后同样通过、
以及 `export-snapshot` 由宿主 Provider 驱动。

## 未验证（禁止当作已具备能力）

- 真实权威快照（约 66.5 万行含村级）下的冷启动耗时与内存峰值：本机离线未下载，**未测**。
- 10 万条/批、更高并发、真实流量下 GC 与连接争用的表现：**未测**。
- 多进程/工作进程共享索引的收益：**未测**。
- 线上真实业务数据的字段识别准确率：现有 100% 只是本包行为回归基线，样本为构造数据。
- 身份证、邮编、OCR、大模型纠错、经纬度、地图 API、地址真实性验证、供应商编码映射、地址簿 CRUD、包内任务队列：**包内没有**。
- 数据库迁移、认证/授权、限流、审计留存：全部归宿主，本包只提供示例代码路径。
- playground 的交互未在真实浏览器里点击验证：三条行为规则由 `test/example-edit.test.ts` 断言纯函数，页面渲染与四个接口由打包验收覆盖。
- `examples/` 下的示例文件（含 playground）不是公开 API，不承诺向后兼容。
