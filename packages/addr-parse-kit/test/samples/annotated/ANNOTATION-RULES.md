# 标注规则（annotated/）

**标注人**：本包实现方（Qoder agent）逐条人工编写，非独立第三方标注。
**标注时间**：2026-09-18。
**评测基准快照**：`test/fixtures.ts` 的 `FIXTURE_NODES`（`datasetId=fixture-ds`，`version=fixture-v1`），
即区域覆盖**只有这份 60 节点的小快照**，所有结论只在该覆盖范围内成立。

## 隐私

所有姓名、电话、楼宇名、订单号一律虚构（`13x0000xxxx` 段、`张伟/李娜/…`）。
不得往本目录粘贴任何来自工单、数据库或线上的真实收件信息。
评测脚本的失败明细只打印用例编号、代码、状态与警告码，**不打印地址原文、姓名和号码**。

## 字段含义

| 字段 | 含义 |
| --- | --- |
| `id` / `category` | 用例编号与考察点 |
| `input` | 收件原文（虚构） |
| `options` | 传给 `parse()` 的选项，缺省即默认值 |
| `gold.deepestCode` | 文本中**真实出现**的最深层区划代码；评测用它反推省/市/区/街道/分组的标准链路 |
| `gold.written` | 文本里**被用户明确写出**的层级（`province`/`city`/`district`/`street`）。缺省表示链路上所有层级都写出了。本包默认 `allowInferred: false`，未写出的层级必须被剥离为 `null`，因此标注必须区分「写出的」与「靠父子关系推出来的」 |
| `expect.status` | `matched`/`ambiguous`/`partial`/`unmatched` |
| `expect.requiresReview` | 是否需要人工确认 |
| `expect.candidateCount` | 候选条数（歧义用例的核心断言：>1 且不得预选） |
| `expect.recipient` | 收件人字段逐值比对（`name`/`phone`/`phoneExtension`/`maskedPhone`/`incompletePhone`/`extraPhones`） |
| `expect.recipientNull` | 期望 `recipient === null` |
| `expect.preserve` | 这些片段必须出现在 `detailedAddress` 或 `residualText` 里（信息不得静默丢失） |
| `expect.warnings` | 必须出现的警告码 |
| `expect.error` | 期望抛出的 `ParseKitError.code`（调用错误类用例） |

## 判定口径

1. **槽位比对取 rank 1 候选**（即系统「预选」给用户看的那一条），不是「取候选集中最匹配的一条」。
   歧义用例另外单独统计「正解是否出现在候选集中」，两者不混算。
2. `gold.deepestCode` 反推出的链路里，`kind === "group"` 的节点落在 `regionGroup`，对应层级槽位必须为 `null`
   （这是本包对 直辖市/省直辖县级 的处理约定，见 `src/internal/map.ts`）。
3. 未收录的别名/简称（如「红河州」）**不期待**被解析出来；期待的是：不得臆造层级，且未匹配文本必须留在 `residualText`。
4. 槽位比对时，`match === "none"` 的节点（疑似命中被退回详细地址，例如「南山区 粤海 路」里的「粤海」）**不算路径槽位**，对应代码按 `null` 计。
5. 文本里作为行政层级被消费掉的片段（如「夹河街」被认成 `夹河街街道`）**不再要求出现在 `detailedAddress` 里**，否则会重复计入「关键内容保留」。
6. 准确率一律按「与人工标注一致的比例」计算。**`confidence` 只是引擎打分，不作为、也不参与任何准确率指标。**
