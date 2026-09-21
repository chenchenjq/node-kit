# addr-parse-kit — 实施规格（spec）

依据：`/tmp` spike 实测（见同目录 `sdk-gap-report.md`）+ 四轮质询定案。基线依赖：`address-smart-parse@4.0.3`（ISC，Node ≥22）。区域数据来自宿主 `area-kit`，本包不依赖、不导出 area-kit。

## 包形态（对齐仓库约定）

- npm workspaces 下 `packages/addr-parse-kit`，`private: true`，`"type": "module"`，tsc 构建（tsconfig.build.json），Vitest。
- `engines.node: ">=22.22.1 <23"`。分发：`npm pack` tgz + 宿主 `npm install ./x.tgz`，禁 registry。
- 出口：`.` = 纯类型 + 浏览器安全纯函数（校验/模式转换/拼接，零 IO、不 import SDK）；`./server` = initParser/parse/parseBatch/RegionProvider（`browser` 条件指向 forbidden stub）。包内无 React 组件。
- 依赖仅 `address-smart-parse`；`peerDependencies` 无。保留 SDK `LICENSE` 说明。

## 公开 API（`./server`）

```ts
initParser(opts: {
  provider: RegionProvider;                  // 宿主实现，桥接 area-kit
  datasetId: string; version: string;        // 必填，显式绑定，无 "active" 语义
  options?: { maxTextLength?: 4096; maxBatchSize?: 100; maxCandidatesDefault?: 5; maxCandidatesHardCap?: 20 }
}): Promise<AddrParser>                      // 按 datasetId+version 缓存索引，进程内复用

interface AddrParser {
  readonly meta: { parserVersion; sdkVersion: '4.0.3'; regionSource; regionVersion; codeScheme }
  parse(text: string, o?: ParseOptions): ParseResult          // 同步
  parseBatch(texts: string[], o?: ParseOptions): BatchItem[]  // 同步 for 循环，逐条 try/catch，保留 index/recordId
}

ParseOptions = {
  mode?: 'withStreet' | 'withoutStreet'      // 默认 withStreet
  extractRecipient?: boolean                 // 默认 true；false = 不出口 name/phone + warning
  maxCandidates?: number                     // 默认 5，硬上限 20，非法报错（不钳制）
  allowInferred?: boolean                    // 默认 false：剥离 inferred 层级
  regionHint?: { provinceCode?; cityCode?; districtCode? }  // 只用于候选排序/过滤，冲突必警示不覆盖
}
```

`parse` 永不抛解析类错误；错误只在入口校验（非字符串、超 4096、批次>100、maxCandidates 非法、区域源初始化失败）。区域源不可用 = 初始化期显式错误，不静默换源。

## 结果结构（`ParsedAddress` / `AddressCandidate`）

- 层级字段 `province/city/district/street`：`{ code, name, sourceName, level, matched: 'explicit'|'inferred'|'none', matchedRange?: [start,end) }`，未知层为 `null`，禁止复制父级/000000 填充。
- 分组伪节点（NodeKind=group，如「市辖区」「省直辖县级行政区划」）不占槽位：对应层级 `null`，节点原样存 `regionGroup` 诊断字段。
- `detailedAddress` / `residualText`：由本包定位扫描（rawInput 区间）推导，**不采用引擎 detail**（引擎 detail 仅作交叉核对入 debug）。空格/标点按原文保留。
- `recipient: { name?, phone?, phoneExtension?, incompletePhone? }`；掩码号码原样保留并标 `incompletePhone`。多姓名/多电话全部保留在 `extra` 并 requiresReview。
- `status: 'matched'|'ambiguous'|'partial'|'unmatched'`——纯结构规则判定（各级 explicit/歧义 warning/截断/层级完整度），confidence 数值只用于排序展示，永不作为确认依据。
- `requiresReview: boolean` + `warnings: Warning[]`（本包自有枚举，含 `STREET_MATCH_SUSPECT`、`NAME_MAY_BE_PLACE`、`ENGINE_DETAIL_MISMATCH`、`RECIPIENTS_AMBIGUOUS`、`PHONE_MASKED`、`LEVELS_INFERRED`、`AMBIGUOUS`、`CANDIDATES_TRUNCATED`、`COVERAGE_UNKNOWN`）。
- 结果自带 `meta`（parser/sdk 版本、regionSource/version、codeScheme）。

## 封装层强制规则（spike 证据 → 实现）

1. 不使用 SDK `parseAddressBatch`（整批抛错缺陷），本包 for 循环逐条隔离。
2. 不暴露 `minConfidence`；内部固定最低值，由本包分类。
3. `maxCandidates` 本包校验（0/负数/超硬上限 → 报错）。
4. `extractIdCard: false` 固定传入；`postalCode/idCard` 永不出口。
5. inferred 层级默认剥离（判定只看节点 `.inferred` 布尔，warnings 不可信）；`allowInferred` 时保留并强制 requiresReview + 原因。
6. 道路后缀守卫：matchedText 为 sourceName 真前缀且紧随 路/街/巷/道/坡/弄 → 该级不成立，文本回并 detailedAddress，warn `STREET_MATCH_SUSPECT`。
7. 姓名守卫：无标签且命中行政区名或带 州/盟/旗/地区 后缀 → 拒绝 name，warn `NAME_MAY_BE_PLACE`。
8. 无候选（引擎返回 []）→ 兜底提取器（标签词 + 高置信手机/座机正则）产出 recipient + `unmatched` 状态 + rawInput，不伪造区划。
9. 槽位重映射：引擎按树深度分配槽位；本包用注入快照的 `code→真实 level/NodeKind` 表重映射回 province/city/district/street；level≥5（村）留在 detailedAddress。

## RegionProvider 接口（本包定义并导出类型；适配器只在 examples/ 提供 area-kit 参考实现）

```ts
interface RegionProvider {
  readonly source: string;                    // 如 'area-kit'
  loadSnapshot(ctx: { datasetId; version }): Promise<RegionSnapshot>  // 全量 1–4 级
  validatePath(codes: string[]): Promise<PathCheck>                   // 宿主人工修正后校验
}
RegionSnapshot = { datasetId; version; codeScheme; nodes: Array<{ code; name; sourceName?; level: 1|2|3|4; parentCode: string|null; kind: 'region'|'group'|'statisticalUnit'|'unknown' }> }
```

适配器路线（Q12c）：参考实现走 `listRegions` 分页拉取（约 200+ 次查询，冷启动耗时实测入报告）；同时支持注入预导出 JSON 快照并校验 datasetId/version。同版本索引复用；版本变化重建；单次调用不混版本；只缓存索引，不缓存/记录收件原文。

## 浏览器侧纯函数（`.` 出口）

`toWithoutStreet(r)/toWithStreet(r)`：返回新对象不改原结果；街道（含 regionGroup 之下的真实乡镇）文本并入 detailedAddress 且幂等（重复转换不重复追加，用 `streetFolded: true` 标记）。`validateParsedAddress(r)`：代码/名称冲突、路径不一致检查。`formatAddress(r, {mode})`：按确认字段拼接，纯地址不含收件人；`formatWithRecipient(r)` 另出「姓名 电话 地址」模板；null 不出现、不虚构缺失层；residualText 默认并入尾部并带提示，绝不承诺逐字还原。

## 测试与验收（对应 Prompt §8 + 性能章节）

- 单测（Vitest，内置 fixtures 小快照：3–5 省含直辖市 group/省直辖县级/跳层/重名区县/重名街道/村级）：覆盖 gap-report 全部 A/B/C/F 用例 + §8 清单（姓名地名混淆、多号码、座机分机、掩码、长订单号、多行单条、候选截断仍确认）。
- 核心回归组：withStreet→withoutStreet 不丢街道、村名门牌房号不丢、反向拼接不重复街道、同名词不误删、原文保留、提取信息不混入纯地址、身份证停用不抹数字。
- 集成（`vitest.postgres.config.ts` + Testcontainers PG）：area-kit CLI 导入裁剪 CSV → 真实 RegionProvider → SDK 全链路；区分合成样例与人工标注集（单独目录，标注者/规则写明），报告字段识别/完整路径/歧义/关键内容保留，不用 confidence 冒充准确率。
- 性能：实跑 1 千 + 1 万档（全量 66.5 万行快照），记录吞吐/p50/p95/p99/内存峰值/事件循环延迟 + 环境（本机、Node 22.22.2、SDK 4.0.3、区域版本、样本构成）；10 万档与在线干扰标「未验证」。
- `scripts/verify-pack.mjs`：npm pack tgz → 仓库外干净 Next.js 宿主 → 类型检查、快照 JSON 注入、解析流程、断网复跑、无 area-kit 下 `tsc` 通过（解耦证明）。
- 敏感约束：测试数据全部虚构；日志默认不落姓名/电话/原文；不打包真实个人信息。

## 文档交付

`README.md`（边界/版本/tgz 安装/Provider 注入/数据准备/最小调用/参考页/命令/许可证与验证范围）、`DATABASE.md`（无状态核心 + PostgreSQL Drizzle 推荐表：recipient_address 字段/类型/可空/索引/编码规则，手机号不做全局唯一键，withStreet 为存储结构、withoutStreet 为视图，名称快照不随区划更新重写，敏感字段按宿主策略）、`AI-USAGE.md`（真实导出/参数/错误码/默认值 + 复用提示词原文 + 批次与部署建议 + 实测容量 + 未验证清单）、`CONTEXT.md` 并登记 `CONTEXT-MAP.md`。issue 记录于本目录。

## 明确不做（首版）

身份证/邮编/OCR/大模型/地图 API/经纬度/真实性验证；自动纠正区划、供应商编码映射、地址簿 CRUD、Excel 导入、独立 HTTP 服务、包内任务平台（持久化/重试/进度归宿主）。
