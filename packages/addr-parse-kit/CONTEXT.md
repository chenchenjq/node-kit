# addr-parse-kit 领域词汇（CONTEXT）

本上下文处理“收件文本 → 可确认的结构化地址”。区域数据本身属于 `packages/area-kit`（区域上下文）；
本包只消费宿主注入的快照，不拥有区划事实。

| 术语 | 定义 | 避免混用 |
| --- | --- | --- |
| 收件原文（input） | 用户粘贴的一段自由文本，可能混有姓名、号码、地址、备注。是敏感个人信息，默认不落日志、不进 URL。 | “地址字符串” |
| 区域快照（RegionSnapshot） | 宿主 Provider 交出的一组 `RegionNode` + `datasetId/version/codeScheme`，是一次解析的唯一区划事实来源。 | 内置数据、兜底数据（本包没有） |
| 区域身份（region identity） | `regionSource + datasetId + regionVersion + codeScheme` 四元组；换其中任一项就是换数据，历史结果必须带身份解释。 | “最新版本” |
| 候选（AddressCandidate） | 一条自洽的解析结论（层级 + 详细地址 + 收件人 + 警告）。多条候选表示歧义，不等于低质量。 | “最佳匹配” |
| 行政槽位（slot） | `province/city/district/street` 四个位置，每级存 `LevelNode`。槽位为空是合法结论，不允许用相邻层级顶替。 | “字段” |
| 分组节点（regionGroup） | 直辖市的“市辖区”、省直辖县级分组等**只用于导航、不是业务行政层级**的节点，单独放 `regionGroup`，不冒充 `city`。 | 二级城市 |
| 统计单元（statisticalUnit） | 村/社区等第五级及类似节点：解析索引不用于占行政槽位，一般也不进快照。 | 街道 |
| 匹配方式（`match`） | `explicit`＝原文里确实出现并可按 span 复原；`inferred`＝上下文唯一推定（默认关闭）；`none`＝只用于排除、不占槽位。 | “置信度高低” |
| 原文区间（span / `matchedRange`） | 节点在收件原文中的字符区间，不变量：`input.slice(begin,end) === matchedText`。 | 位置猜测 |
| 详细地址（detailedAddress） | 行政层级消费之后剩下的正文：路名、门牌、栋、单元、房号、备注必须保留在这里。 | “剩余原文” |
| 残差（residualText） | 既没进槽位也没进详细地址的原文片段，是复核线索，不是垃圾。 | 丢弃文本 |
| 输出模式（`mode`） | `withStreet`（四级 + 详细地址，**归一存储结构**）与 `withoutStreet`（街道并入详细地址的展示视图）。 | 两种数据 |
| 并回 / 复原（fold / restore） | `toWithoutStreet` 把原文出现过的街道文本按 `matchedText` 拼回详细地址前部并记 `streetFolded`；`toWithStreet` 反向复原。两者幂等且返回新对象。 | 删除街道 |
| 解析状态（`status`） | `matched / ambiguous / partial / unmatched`，描述机器结论的完整度，与“是否已确认”无关。 | 确认状态 |
| 需复核（`requiresReview`） | 歧义、推断、残差、可疑街道匹配都会置真；它是排期信号，不是错误。 | 失败 |
| 置信度（`confidence`） | 只用于候选排序的相对分数，**不是可配送或真实存在的证明**。 | 准确率 |
| 区域提示（`regionHint`） | 宿主传入的先验：只用于剔除与原文明示区域冲突的候选，绝不覆盖原文；冲突时保留原文并给 `HINT_CONFLICT`。 | 强制指定 |
| 解析建议 vs 确认结果 | 前者是本包输出，后者是用户/宿主动作（`confirmed_at`）。任何写入确认结果的路径都必须经过显式确认。 | “解析成功即确认” |
| 名称快照 | 与代码一起落库的层级名称。区域换代后不回写，历史行永远按当时的名称显示。 | 当前名称 |
| 结构校验 / 路径校验 | `parser.validateSelection` 只查代码存在、层级递增、父子结构；`provider.validatePath` 由宿主区域数据给出权威父子结论。两者都过才允许落库。 | 二选一 |
| 完整性校验（`validateAddressIntegrity`） | 纯结构自检（槽位与层级一致、名称非空、折叠标记与详细地址自洽、无 `undefined` 字样），不访问区域数据。 | 路径校验 |
| 索引缓存键 | `provider.source|datasetId|version`，进程内只构建一次索引；跨进程不共享。 | 全局单例 |

## playground 行为不变量

1. 默认只填空项：解析结果不覆盖已有的非空字段，覆盖需要显式确认。
2. 歧义不预选：多条候选时不默认选中任何一条，包括第一条。
3. 换区域清下级：改动任一层级即清空更深层级代码，禁止“新名称 + 旧代码”混排提交。

## 相关文档

`README.md`（公开 API 与边界）、`DATABASE.md`（落库结构与视图约定）、`AI-USAGE.md`（代理接入约束与实测容量）、
`CONTEXT-MAP.md`（本上下文在仓库中的位置）。
