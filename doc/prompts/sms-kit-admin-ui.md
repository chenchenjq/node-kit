# sms-kit 管理端 AI 开发 Prompt

将以下 Prompt 交给能够读取宿主 Next.js 仓库的编码 Agent。使用前确保后端已经实现 `sms-kit` 管理 API 和 `sms-kit/next/types`，或提供导入同一类型并通过类型检查的模拟服务。不得在缺少 DTO 时自行猜测接口。

---

你是一名资深 Next.js 和 TypeScript 工程师。请在当前宿主项目中实现 sms-kit 短信管理端。先阅读项目现有目录、编码规范、组件库封装、权限系统、请求层和测试配置，再提出一个简短实现设计并等待确认；确认前不要写代码。

## 目标

实现一个安全、可访问、状态完整的短信管理页面，供管理员配置阿里云国内短信、同步签名和模板、管理验证码用途、查看回执健康、查询发送记录和统计。sms-kit 是 headless 服务端包，前端不得复制它的领域逻辑。

## 技术与安全约束

- 使用当前项目的 Next.js App Router、TypeScript strict、Tailwind CSS 和 shadcn/ui。
- 遵循项目现有数据请求与表单方案；若项目没有约定，使用 React Hook Form 和 Zod。
- 调用阿里云 SDK、PostgreSQL、SecretResolver、PhoneNumberProtector 或 sms-kit 敏感入口的代码只能在 Node.js Runtime 服务端；不要部署到 Edge Runtime。Client Component 只能以 `import type` 使用 `sms-kit/next/types`，不得导入 `application`、`security`、`postgres`、`aliyun`、`better-auth` 或 `next` 等敏感运行时入口；宿主服务端代码使用 Next.js `server-only` 边界。
- 服务端绝不能向客户端回传 AccessKey、AccessKey Secret、OTP、完整手机号、未过滤模板变量或供应商原始回执。管理员主动输入的测试号码或精确查询号码只作为一次性 HTTPS 请求字段，客户端不得持久化、缓存、分析或记录，操作结束后清除输入状态。
- 不创建短信领域状态机，不自行判断是否允许重试；渲染服务端 DTO 返回的状态、权限和稳定错误码。
- 所有写操作必须由服务端鉴权。前端的隐藏或禁用不能替代服务端权限检查。
- 不增加营销群发、联系人管理、国际短信、多供应商或在线编辑云端模板功能。
- 从 `sms-kit/next/types` 导入 API DTO、分页类型和错误码。若该入口不存在，停止并报告后端前置条件，不得自建猜测版本。
- 租户只能来自宿主可信认证上下文；不要在客户端提供任意 `tenantId` 输入或把它写入 URL。单租户宿主使用固定默认租户键。系统配置与资源可共享，但发送记录、任务、回执健康和统计只展示当前租户。

## API 契约

默认前缀为 `/api/admin/sms`。使用以下端点：`GET /overview`、`GET/PATCH /config`、`POST /config/test-connection`、`POST /config/test-send`、`POST /resources/sync-preview`、`POST /resources/sync-commit`、`GET /signatures`、`PATCH /signatures/:id`、`GET /templates`、`POST /templates/import`、`PATCH /templates/:id`、`GET/PATCH /verification`、`GET /receipt-health`、`POST /reconcile`、`GET /messages`、`GET /messages/:id`、`GET /stats` 和 `GET /jobs/:id`。成功、分页、错误、版本和幂等结构以 `sms-kit/next/types` 为唯一事实来源。

## 页面结构

创建“短信管理”页面，使用同页资源标签：

1. 服务配置
2. 签名
3. 模板
4. 验证码
5. 回执与补查
6. 发送记录
7. 统计

标题区始终显示整体状态、最近权限测试、最近回执、系统当日预算占用、人工熔断状态和告警数。把当前标签、分页、筛选和日期范围写入 URL 查询参数。

## 必须实现的交互

### 服务配置

- 编辑供应商、区域、可选端点和两个密钥引用；端点字段只接受并原样回填凭据无关的 HTTPS origin，不允许路径、查询、片段或用户信息。
- 已保存引用只显示 scheme 与脱敏名称，绝不回显解析值。
- 配置变化后展示“待测试”；权限测试成功后才能启用。
- 提供“测试连接”和“真实发送测试”两个独立操作。
- 真实发送测试对话框展示脱敏手机号、签名、模板、变量名和费用提示，并要求显式确认。
- 使用服务端 `version` 处理乐观锁冲突，不静默覆盖。

### 签名和模板

- 同步前展示新增、变化、不可用和未导入资源的差异预览，以及同步 ID、候选 ID、校验和与过期时间。
- 管理员确认后才提交同步结果；过期或校验冲突时禁止提交并要求重新同步。
- 模板导入必须填写稳定模板键、签名和用途，并检查变量集合。
- 停用签名或模板前展示影响范围。
- 云端不可用与本地停用使用不同状态徽标。

### 验证码

- 分开显示 Better Auth 登录/找回密码模板映射和高风险 Challenge 设置。
- 明确标注 Better Auth 负责用户、验证码验证和会话，sms-kit 仅适配发送。
- 标注首版只允许已有账号登录，宿主必须省略 `signUpOnVerification`（不得传入 `false`），不提供手机号注册入口。
- 展示并可按 DTO 编辑验证码长度、有效期、最大尝试次数、证明有效期、手机号发送间隔/小时/每日限制、IP 窗口限制、可选系统级 UTC 每日预算和人工熔断原因。
- 策略保存必须携带独立的 `version`；预算为空显示“不限制”。降低安全阈值、提高发送上限、修改预算或切换熔断要二次确认，熔断开启时常驻提示所有真实发送将被拒绝。
- 供应商配置与安全策略独立保存，任何一方的版本冲突不得覆盖另一方。

### 回执与补查

- 展示回调状态、最近回调、重复回执、无法关联的合法回执、待补查和最终未知数量；未匹配回执突增时告警，但不展示原始载荷或完整手机号。
- 手动补查必须选择时间范围或具体消息，提交前显示预计数量，提交后显示后台任务 ID。

### 发送记录

- 支持日期、模板键、用途、受理状态、送达状态和脱敏手机号筛选。
- 受理状态与送达状态必须分列，不能合成“成功”。
- 详情显示消息时间线、供应商调用 Attempt、回执来源、稳定错误码、Request ID/BizId 和脱敏元数据。

### 统计

- 指标卡展示提交、受理、明确拒绝、受理未知、受理率、等待送达、已送达、送达率、送达失败和最终未知。
- 明确显示受理率分母为提交数，送达率分母为受理数。
- 直接使用 DTO 中明确命名的受理与送达计数字段，不把通用 `failed/unknown` 混用于两个阶段，也不在前端重建领域状态机。
- 提供按天趋势图和按模板键/用途拆分表。
- 图表提供文本摘要和等价数据表入口。

## 状态完整性

每个查询区域必须实现加载骨架、空状态、错误状态、重试、部分成功和无权限状态。后台任务不能用成功 Toast 冒充已完成；提交后展示任务 ID 和可查询状态。稳定错误码可复制，供应商原始消息只显示服务端脱敏后的内容。使用 PRD 第 11.1 节定义的响应封装、分页和写请求并发语义。

## 权限

消费服务端提供的权限集合：`config.read`、`config.write`、`resource.sync`、`signature.manage`、`template.manage`、`sms.test`、`message.read`、`stats.read`、`receipt.reconcile`。缺少写权限时隐藏或禁用相应操作并说明原因；缺少读取权限时不请求相关数据。

## 组件边界

优先拆分为：`SmsAdminShell`、`ProviderConfigForm`、`ConnectionTestPanel`、`TestSendDialog`、`ResourceSyncPreview`、`SignatureTable`、`TemplateTable`、`TemplateImportDialog`、`VerificationSettings`、`ReceiptHealthPanel`、`ReconcileDialog`、`MessageFilters`、`MessageTable`、`MessageTimeline`、`SmsMetricCards`、`DeliveryTrendChart` 和 `TemplateBreakdownTable`。根据宿主项目已有模式调整文件位置，但不要把所有功能放在一个大组件中。

## 无障碍和响应式

- 标签、表格操作、对话框和抽屉必须支持键盘。
- 对话框正确管理打开与关闭焦点。
- 表单有持久标签、说明、字段错误和错误摘要。
- 状态不只使用颜色表达，文字与背景满足 WCAG AA 对比。
- 窄屏将次要表格列放入详情，不堆叠成不可读的横向表格。
- 图表包含可访问名称、摘要和数据表替代入口。

## 测试要求

- 为状态格式化、权限分支和错误映射编写单元测试。
- 为配置保存、连接测试、同步差异预览、模板导入、启停确认、真实发送确认和乐观锁冲突编写组件测试。
- 验证键盘导航、焦点恢复、错误摘要和无权限状态。
- 编写关键 E2E：首次配置 → 权限测试 → 同步资源 → 导入并启用模板 → 模拟发送 → 接收模拟回执 → 统计更新。
- 只使用虚构手机号和模拟 Provider；测试 fixture 禁止出现真实 Secret。
- 模拟服务必须导入并满足 `sms-kit/next/types`，测试同步预览过期、校验冲突和 API 未知字段拒绝。
- 测试策略安全确认、预算为空/触顶、人工熔断常驻告警，以及供应商配置与策略配置之间互不覆盖的并发冲突。
- 在最小 Next.js 构建 fixture 中证明服务端入口可用、Client Component 导入敏感入口会失败、`sms-kit/next/types` 纯类型导入可通过。
- 使用两个虚构租户验证记录、精确手机号查询、任务和统计隔离；同一幂等键在两个租户内应可分别成功。

## 完成标准

完成后运行宿主项目针对受影响范围声明的格式化、类型检查、测试和构建命令。报告修改的文件、验证结果、仍由后端或部署环境决定的事项。不要声称真实阿里云发送成功，除非用户显式授权了隔离的真实联调且提供的是已轮换、最小权限、环境变量注入的测试凭据。

---
