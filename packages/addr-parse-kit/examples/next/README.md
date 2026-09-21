# addr-parse-kit 示例宿主（Next.js playground）

这不是可独立运行的工程：目录里**故意没有 `package.json`**，它随 tgz 一起分发，
必须由宿主复制进自己的 Next.js App Router 工程后再构建（`scripts/verify-pack.mjs` 就是这么做的）。
在包仓库目录里直接 `next build` 会被 Next 把包根当成项目根，报 “Couldn't find any pages or app directory”。

## 复制哪些文件

| 文件 | 作用 | 宿主改造点 |
| --- | --- | --- |
| `lib/provider.ts` | 最小离线快照 Provider（不依赖任何区域包） | 换成宿主自己的区域数据源，参考 `examples/area-kit-provider.ts` |
| `lib/host.ts` | 装配点：解析器单例、认证/限流桩、确认落库前复核、演示用内存暂存 | 替换认证/限流实现，把 `host.saved` 换成真实表 |
| `lib/protocol.ts` | 请求/响应形状与纯校验（客户端与服务端共用） | 按业务收紧字段与长度 |
| `lib/edit.ts` | 浏览器侧纯函数：候选→表单草稿、换区域清下级、模式切换 | 一般不改 |
| `lib/http.ts` | 路由包装：认证 → 限流 → 处理 → 错误映射 → 审计日志 | 接入宿主日志/追踪 |
| `app/page.tsx` | playground 页面（粘贴 → 解析 → 候选/警告 → 手工修正 → 模式切换 → 重组预览 → 确认） | 拆成宿主组件 |
| `app/api/*/route.ts` | `parse` `regions` `validate` `confirm` 四个端点 | 加宿主鉴权与限流 |
| `data/area-snapshot.demo.json` | **虚构**演示快照（约 61 个节点） | 生产前删除，改用 `scripts/export-snapshot.mjs` 导出自己的快照 |

## 接口

- `POST /api/parse` 请求体 `{ text, extractRecipient?, maxCandidates?, allowInferred?, regionHint? }`；收件原文只走请求体，不进 URL。
- `GET /api/regions?parentCode=`：按注入快照返回下级节点（分组节点带 `kind: "group"`）。
- `POST /api/validate` `{ codes: (string|null)[] }`：合并 `parser.validateSelection` 与 `provider.validatePath` 的结论。
- `POST /api/confirm`：服务端复核（代码/名称快照配对、层级、父子路径、meta 与服务端一致），通过后返回记录 id；
  生产宿主应只返回 id，不回显收件信息。

环境变量：`ADDR_PARSE_SNAPSHOT`（快照文件路径）、`ADDR_PARSE_DATASET_ID` / `ADDR_PARSE_VERSION`（钉版，缺省用快照自带值）、
`ADDR_PARSE_DEMO_SESSION`（设置后所有接口要求匹配的 `addr_parse_session` cookie）、`ADDR_PARSE_DEMO_RATE_LIMIT`（每 60 秒窗口上限，默认 120）。

## 页面上必须看到的三条规则

1. **默认只填空项**：选候选或点“填充表单”时，非空字段不覆盖；出现冲突时显示冲突字段清单，
   勾选“确认覆盖已有非空字段”才写入（示例里预置了一个已有号码 `13600007777` 用来触发这条路径）。
2. **歧义不预选**：候选以编号列表呈现，没有任何一条被默认选中；`AMBIGUOUS`/`requiresReview` 会显示为需复核，
   确认按钮在勾选“我已核对”之前禁用——解析成功不等于用户确认。
3. **换区域清下级**：改动任一层级后，比它更深的层级代码全部清空（含分组节点），
   人工选中的节点标为 `match: "explicit"`；服务端还会用快照复核“名称↔代码”配对，拒绝“新名称 + 旧代码”。

隐藏街道（切到 `withoutStreet` 视图）时页面显示并回提示：街道文本按原文 `matchedText` 并入详细地址前部，
可复原回 `withStreet`；重组预览用 `formatAddress`/`formatRecipientLine`/`validateAddressIntegrity`，
残差 `residualText` 与完整性问题都直接展示，不做静默修正。

## 验收覆盖

`node scripts/verify-pack.mjs` 会在仓库外干净宿主里（**不安装 area-kit**）跑：
`next build`（含“客户端导入 `addr-parse-kit/server` 必须构建失败”的负例）、
`next start` 后的真实 HTTP 流程（无凭证 401、解析、跨区校验拒绝、陈旧名称快照拒绝、伪造 `regionVersion` 拒绝、超长 413、限流 429）、
以及初始化后在进程级断网守卫下重复同样的检查。

演示快照与页面样本里的姓名、号码、地址全部为虚构，不含任何真实个人信息。
