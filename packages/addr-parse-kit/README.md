# addr-parse-kit

中文收件地址解析包：把「收件人 + 电话 + 省市区街道 + 门牌房号」混写的一段文本，解析成**可确认**的结构化结果。
区域数据不内置，由宿主已有的区域包（如 `area-kit`）或 JSON 快照注入；本包只做解析、拼接与结构校验。

- 它做的事：候选路径 + 置信度、原文区间（span）、详细地址/残差、收件人字段、警告码、输出模式转换、反向拼接、路径结构校验。
- 它不做的事：不内置区划数据、不猜代码、不猜缺失数字、不自动落库、不发外部请求、不替代宿主的认证/限流/存储。
- **解析成功不等于用户确认**：`confidence` 只用于候选排序，任何确认动作都由宿主/用户完成。

## 分发与安装

包保持 `private: true`，通过 `npm pack` 产出的 tgz 交付，不发布到任何 registry，配置文件里也不出现 registry 地址：

```bash
npm pack --pack-destination ./dist-tgz           # 在仓库内产出 addr-parse-kit-0.0.0.tgz
npm install ./dist-tgz/addr-parse-kit-0.0.0.tgz  # 宿主安装为真实依赖，不依赖工作区软链
```

要求 Node `>=22.22.1 <23`，纯 ESM，TypeScript 严格模式（`noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`）。

## 两个入口

| 入口 | 内容 | 可用位置 |
| --- | --- | --- |
| `addr-parse-kit` | 全部类型 + 纯函数（模式转换、反向拼接、结构校验） | 服务端与浏览器 |
| `addr-parse-kit/server` | `initParser`、`ParseKitError`、`DEFAULT_LIMITS` | 仅服务端 |

`./server` 的 `browser` 条件指向一个抛错的护栏模块（`dist/browser-forbidden.js`，内部 `import "server-only"`），
客户端组件里导入它会在构建期失败，而不是运行时把解析逻辑打进浏览器包。

## 服务端初始化

宿主必须显式钉住 `datasetId` 与 `version`——本包不支持“跟随 active 版本”的隐式语义；
provider 返回别的版本时抛 `E_REGION_VERSION_MISMATCH`，加载失败时抛 `E_REGION_INIT`，**不会静默换数据源**。

```typescript
import { initParser, type RegionProvider } from "addr-parse-kit/server";

declare const provider: RegionProvider;

export const parser = await initParser({
  provider,
  datasetId: "china-area",
  version: "2026Q1",
  limits: { maxTextLength: 2048, maxBatchSize: 50 },
});

export const identity = {
  regionSource: parser.meta.regionSource,
  datasetId: parser.meta.datasetId,
  regionVersion: parser.meta.regionVersion,
  codeScheme: parser.meta.codeScheme,
  parserVersion: parser.meta.parserVersion,
  sdkVersion: parser.meta.sdkVersion,
};
```

同一 `provider.source|datasetId|version` 的索引与解析引擎在进程内只构建一次（模块级缓存）；
之后的 `initParser` 只返回新的包装对象，不再调用 `loadSnapshot`。多进程部署时每个进程各自初始化一次。

## RegionProvider 契约

```typescript
import type { PathCheck, RegionNode, RegionProvider, RegionSnapshot } from "addr-parse-kit";

export function createProvider(load: () => Promise<RegionSnapshot>): RegionProvider {
  const parents = new Map<string, string | null>();
  return {
    source: "my-area-source",
    async loadSnapshot(context: { datasetId: string; version: string }): Promise<RegionSnapshot> {
      const snapshot = await load();
      if (snapshot.datasetId !== context.datasetId || snapshot.version !== context.version) return snapshot;
      for (const node of snapshot.nodes) parents.set(node.code, node.parentCode);
      return snapshot;
    },
    async validatePath(codes: readonly (string | null)[]): Promise<PathCheck> {
      const filled = codes.filter((code): code is string => typeof code === "string" && code.length > 0);
      const problems: { code: string; reason: string }[] = [];
      let cursor: string | null | undefined = filled[filled.length - 1];
      const ancestors = new Set<string>();
      while (cursor !== undefined && cursor !== null) {
        ancestors.add(cursor);
        cursor = parents.get(cursor) ?? null;
      }
      for (const code of filled) if (!ancestors.has(code)) problems.push({ code, reason: `${code} 不是末级区域的祖先` });
      return { ok: problems.length === 0, problems };
    },
  };
}

export type { RegionNode };
```

参考实现随包提供，宿主复制后按自己的鉴权与数据集选择改造：

- `examples/area-kit-provider.ts`：`createAreaKitProvider`（对接 area-kit 公开读接口，带分级完整性核对）与 `createJsonSnapshotProvider`。
- `examples/next/lib/provider.ts`：不依赖 area-kit 的最小离线快照 Provider。
- `scripts/export-snapshot.mjs`：把宿主 Provider 导出成 JSON 快照（不读写数据库，`--provider` 指定宿主模块）。

## 解析

```typescript
import type { ParseResult } from "addr-parse-kit/server";
import { initParser, type RegionProvider } from "addr-parse-kit/server";

declare const provider: RegionProvider;
const parser = await initParser({ provider, datasetId: "china-area", version: "2026Q1" });

export function readAddress(text: string): ParseResult {
  const result = parser.parse(text, { maxCandidates: 5, allowInferred: false, extractRecipient: true });
  // 多条候选时不取第一条冒充确定结果；由宿主界面让用户确认。
  const review = result.candidates.filter((candidate) => candidate.requiresReview);
  return { ...result, requiresReview: result.requiresReview || review.length > 0 };
}
```

`ParseOptions`：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `extractRecipient` | `true` | 关闭后只返回地址结构，`recipient` 为 `null`，并给 `RECIPIENT_SUPPRESSED` |
| `maxCandidates` | `limits.maxCandidatesDefault`（5） | 取值 `1..20`，越界抛 `E_MAX_CANDIDATES`（不静默钳制）；截断时给 `CANDIDATES_TRUNCATED` |
| `allowInferred` | `false` | 原文没写且无法从上下文唯一确定的上级默认留 `null`；开启后写入 `match: "inferred"` 并给 `LEVELS_INFERRED` + 需复核 |
| `regionHint` | 无 | 只用于**剔除与原文明示区域冲突**的候选；与原文冲突时保留原文结果并给 `HINT_CONFLICT`，绝不覆盖 |

候选结构：`status`（`matched|ambiguous|partial|unmatched`）、`requiresReview`、`warnings[]`、
`province/city/district/street/regionGroup`（每级含 `code/name/sourceName/level/match/matchedText/matchedRange`）、
`detailedAddress`（行政区消费后的剩余正文）、`residualText`（未被消费的原文片段）、`recipient`、`mode`。
`match` 为 `explicit|inferred|none`，`none` 表示该节点只用于排除、不占行政槽位；
直辖市的“市辖区”和省直辖县级分组进 `regionGroup`，不冒充 `city`。

## 输出模式与反向拼接

```typescript
import { formatAddress, formatRecipientLine, toWithoutStreet, toWithStreet, validateAddressIntegrity } from "addr-parse-kit";
import type { AddressCandidate } from "addr-parse-kit";

export function preview(candidate: AddressCandidate, withStreet: boolean): string[] {
  const view = withStreet ? toWithStreet(candidate) : toWithoutStreet(candidate);
  return [
    formatAddress(view, { mode: withStreet ? "withStreet" : "withoutStreet" }),
    formatRecipientLine(view),
    ...validateAddressIntegrity(view).map((issue) => `${issue.field}: ${issue.reason}`),
  ];
}
```

`withStreet → withoutStreet` 不丢弃街道：原文里出现过的街道文本按 `matchedText` 并回 `detailedAddress` 前部，
并在 `streetFolded` 里记录原文与复原入口；两个转换都幂等、返回新对象。
`formatAddress` 只使用明确字段，跳过 `null` 与 `match: "none"`，不虚构缺失层级，也不重复相邻段。

## 校验与批量

```typescript
import { initParser, type AddrParser, type BatchItem, type RegionProvider } from "addr-parse-kit/server";

declare const provider: RegionProvider;
const parser: AddrParser = await initParser({ provider, datasetId: "china-area", version: "2026Q1" });

export function check(codes: readonly (string | null | undefined)[]): boolean {
  return parser.validateSelection(codes).ok;
}

export function bulk(texts: readonly string[], ids: readonly string[]): BatchItem[] {
  const items: BatchItem[] = [];
  for (let offset = 0; offset < texts.length; offset += parser.limits.maxBatchSize) {
    const slice = texts.slice(offset, offset + parser.limits.maxBatchSize);
    items.push(...parser.parseBatch(slice, {}, ids.slice(offset, offset + slice.length)));
  }
  return items;
}
```

`validateSelection` 只做结构校验（代码存在、层级递增、构成父子路径）；父子关系的权威结论来自
`provider.validatePath`（宿主自己的区域数据），两者都要过时才允许落库。
`parseBatch` 要求显式数组、长度 ≤ `limits.maxBatchSize`（默认 100），逐条返回 `{index, recordId?, ok, result?, error?}`，
单条失败不影响同批其他条目。解析本身是同步 CPU 操作：一次请求里解析上百条会让该进程停顿，
高并发请按条分片或放到独立工作进程。

## 错误码与默认限额

| 错误码 | 触发 | HTTP 建议 |
| --- | --- | --- |
| `E_INPUT_TYPE` / `E_INPUT_EMPTY` | 非字符串 / 全空白 | 400 |
| `E_INPUT_TOO_LONG` | 超过 `limits.maxTextLength` | 413 |
| `E_MAX_CANDIDATES` | `maxCandidates` 越界或非整数 | 400 |
| `E_BATCH_NOT_ARRAY` / `E_BATCH_TOO_LARGE` | 批量入参非数组 / 超上限 | 400 |
| `E_REGION_INIT` | Provider 接口不符 / 快照加载或索引构建失败 | 503 |
| `E_REGION_VERSION_MISMATCH` | Provider 返回的版本与请求不一致 | 503 |
| `E_SNAPSHOT_INVALID` | 快照残缺（空节点、代码重复、父级缺失、层级非递增） | 503 |

`DEFAULT_LIMITS = { maxTextLength: 4096, maxBatchSize: 100, maxCandidatesDefault: 5, maxCandidatesHardCap: 20 }`，
初始化时可覆盖，实例上通过 `parser.limits` 读取。

## 示例与验收

- `examples/next/`：仓库内 Next.js playground（粘贴 → 解析 → 候选/警告 → 手工修正 → 模式切换 → 重组预览 → 确认交宿主），
  含默认只填空项、歧义不预选、换区域清下级三条规则。见其目录下的 `README.md`。
- `node scripts/verify-pack.mjs`：`npm pack` → 仓库外干净宿主（**不安装 area-kit**）→ 校验 tgz 清单、双入口、
  类型（宿主 `tsc` + 文档示例）、客户端越界导入被 `next build` 拒绝、快照注入、错误码、
  `next build`/`next start` 端到端 HTTP，以及初始化后断网仍可运行。证据写入 `artifacts/pack-verification.json`。
- `npm test`（单元 + 样例评测）、`npm run test:integration`（Testcontainers PostgreSQL + 真实 area-kit 链路）、
  `npm run bench`（性能档位压测）。

## 边界与合规红线

- 日志默认不得出现收件原文、姓名、号码；`ParseResult.input` 含原文，宿主自行决定是否留存。
- 不要把完整收件信息放进 URL 查询参数（访问日志、代理日志、浏览器历史都会留下）。
- 不向任何外部服务发送收件原文；本包运行期无网络调用，区域数据只来自宿主 Provider。
- 不把测试里的真实个人信息打包；示例数据全部为虚构。
- 手机号不得作为收件记录的全局唯一键（一个号码对应多人多地址是常态）。
- 宿主的对外接口必须自行实施认证、限流与输入校验；本包的输入校验只防误用，不防攻击。

## 未验证（不得当作已实现能力）

- 真实权威快照（约 66.5 万行含村级）下的冷启动耗时与内存占用。
- 10 万条/批与更高并发下的吞吐、延迟与 GC 表现。
- 多进程/工作进程共享索引的收益。
- 真实业务数据上的字段识别准确率（现有 100% 指标只是本包的行为回归基线）。

## 文档

`DATABASE.md`（落库结构与 PostgreSQL/Drizzle 示例）、`AI-USAGE.md`（给编码代理的接入约束与复用提示词）、
`CONTEXT.md`（术语）、`examples/area-kit-provider.ts`（宿主 Provider 参考实现）。
