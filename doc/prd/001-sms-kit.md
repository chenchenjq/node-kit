# sms-kit 可复用短信基础包 PRD

## 1. 文档信息

- 状态：修订待复审
- 日期：2026-09-13
- 目标包：`sms-kit`
- 目标目录：`packages/sms-kit/`
- 首要宿主：Next.js，Node.js Runtime

## 2. 背景

项目需要一个可复用、仅服务端运行的私有 Node.js 短信基础包。首版以阿里云国内短信为唯一供应商，提供授权配置、签名与模板同步、模板化发送、短信验证码、Better Auth 适配、发送记录、送达回执和统计能力。包不包含可部署应用或前端组件，但应提供 PostgreSQL 数据库规范、Next.js 管理端设计规范和可直接交给编码 Agent 的前端开发 Prompt。

当前仓库尚无包实现、Next.js 应用、Better Auth 配置或数据库结构，因此本项目按新子系统设计。

## 3. 目标

1. 提供稳定、类型安全、供应商可替换的短信发送接口。
2. 安全配置阿里云凭据引用，并分别验证连接权限和真实发送能力。
3. 从阿里云同步已审核签名与模板，由管理员选择导入、设置稳定模板键并启停。
4. 允许其他功能按稳定模板键发送单接收人事务短信。
5. 适配 Better Auth 的手机号验证码免密登录和手机号找回密码流程。
6. 为修改密码和高风险操作提供通用、单次使用的短信验证 Challenge。
7. 分别记录提交、供应商受理和最终送达状态，并提供明细和匿名汇总统计。
8. 通过模拟测试、PostgreSQL 集成测试和显式真实联调建立可重复的质量保障。

## 4. 非目标

- 不支持国际、港澳台短信。
- 不提供营销活动、联系人管理、Excel 导入、群发任务或批量发送 API。
- 不创建或托管 Better Auth 实例、用户、账户和会话。
- 不把 Tailwind CSS、shadcn/ui 或其他前端依赖打入 `sms-kit`。
- 不绑定 Prisma、Drizzle、Vercel Cron、Redis 或具体队列产品。
- 不在首版实现阿里云以外的供应商，但保留 Provider 接口。
- 不提供短信内容在线编辑或向阿里云创建、修改、删除签名与模板的能力。

## 5. 已批准的关键决策

| 主题 | 决策 |
| --- | --- |
| 包形态 | 单包分层，通过子路径导出隔离模块 |
| 包名 | `sms-kit`，初始设置 `"private": true` |
| 技术基线 | TypeScript strict、Node.js 20+、ESM、类型声明、server-only |
| 数据访问 | 核心 ORM 无关；提供 PostgreSQL DDL、迁移、可选 `pg` 适配器及契约测试 |
| 部署模型 | 单系统实例、单活动短信配置 |
| 供应商 | 阿里云国内短信 |
| 凭据 | 只持久化密钥引用；内置环境变量解析器并允许自定义解析器 |
| 模板调用 | 管理员录入本地稳定键，业务模块不依赖阿里云 TemplateCode |
| 发送模式 | OTP 优先直发；普通事务短信异步发送；受理结果未知时禁止自动重发 |
| 送达状态 | HTTP 回调为主，`QuerySendDetails` 定时补查 |
| 认证 | Better Auth 为可选适配器；短信验证码免密登录 |
| 前端 | 资源标签页；Next.js + Tailwind CSS + shadcn/ui 规范 |
| 测试 | 模拟与 PostgreSQL 集成测试默认运行；真实阿里云联调显式开启 |

## 6. 包结构与公共边界

建议通过 `package.json` 的 `exports` 暴露以下子路径：

- `sms-kit/core`：领域类型、发送服务、模板变量校验、状态机、错误模型。
- `sms-kit/aliyun`：阿里云授权测试、签名/模板查询、发送、回执解析和发送详情查询。
- `sms-kit/storage`：ORM 无关的 Store 接口、事务接口和存储契约测试。
- `sms-kit/postgres`：可选 `pg` 适配器、迁移器和测试数据工具。
- `sms-kit/better-auth`：Better Auth Phone Number 插件发送回调适配器。
- `sms-kit/next`：管理 API、回执和定时任务所需的 Route Handler 工厂。
- `sms-kit/testing`：模拟 Provider、固定时钟、种子工厂和故障注入工具。

核心模块不得依赖 Next.js、Better Auth、阿里云 SDK 或 PostgreSQL 驱动。所有运行时入口必须声明为仅服务端使用，避免凭据解析和数据库代码进入浏览器包。

### 6.1 稳定端口

- `SmsProvider`：测试授权、列出云端资源、发送、查询发送详情、解析回执。
- `SmsStore`：配置、资源、消息、尝试、回执、任务、Challenge、限流、审计和统计的持久化。
- `SecretResolver`：根据引用按需解析 Secret。
- `PhoneNumberProtector`：规范化、加密、解密、检索哈希和脱敏。
- `MessagePayloadProtector`：加密、解密普通异步短信的模板变量，并携带密钥版本用于轮换。
- `Authorizer`：由宿主决定管理操作是否允许。
- `SmsTransaction`：允许 `pg` 适配器加入宿主现有事务，用于原子消费高风险证明。
- `Clock`、`IdGenerator`、`EventSink`：支持确定性测试和可观测性。

## 7. 功能需求

### 7.1 服务配置

- 数据库只允许一个活动配置，供应商固定为 `aliyun`。
- 保存区域、端点、AccessKey ID 引用、AccessKey Secret 引用、启用状态和乐观锁版本。
- 初始内置 `env://变量名` 引用解析；允许宿主注册其他 scheme。
- 配置读取接口不得返回已解析 Secret，只返回引用类型和脱敏引用名称。
- Secret 只在单次操作中存在，不进入缓存、结构化事件、错误对象或数据库。

### 7.2 两阶段授权测试

第一阶段为无短信费用的连接与权限测试：解析密钥引用，调用签名和模板查询接口，验证凭据、短信权限和资源可见性。

第二阶段为显式真实发送测试：管理员选择已导入且启用的签名、模板和白名单手机号，确认脱敏目标、模板和变量后发送。白名单由宿主运行时配置提供，不把完整号码写入短信配置表。测试短信必须进入常规消息、回执、审计和统计链路。

测试结果仅保存阶段、结果、稳定错误码、供应商错误码、资源数量、耗时和时间，不保存凭据值。

### 7.3 签名与模板同步

- 调用阿里云 `QuerySmsSignList` 和 `QuerySmsTemplateList` 获取云端资源，必须完整处理分页；任一页失败时同步批次标记为部分失败，不把不完整结果解释为云端删除。
- 同步结果保存为一次资源同步批次，并为每个候选资源保存脱敏快照、供应商稳定键、校验和和过期时间，可展示新增、变更、不可用和错误数量。
- 只有管理员明确选择的资源才能导入本地系统。
- 提交导入时必须校验同步批次未过期且候选校验和一致；不一致时要求重新同步，不能静默导入已变化资源。
- 导入模板时管理员必须录入符合约束的稳定键，如 `auth.login_otp`。
- 本地启停、用途和稳定键不被后续同步覆盖。
- 云端审核状态不再可用时，禁止新发送并产生可观测事件。
- 首版不向阿里云创建、编辑或删除签名与模板。

### 7.4 模板与模块调用

业务模块使用稳定模板键调用，不直接传入签名名称或 TemplateCode。核心发送输入至少包含：

- `templateKey`
- 中国内地手机号
- 模板变量对象
- `purpose`
- 业务幂等键
- 可选、经过允许列表过滤的业务元数据

发送前必须检查模板存在、已启用、云端状态可用、用途匹配、签名可用，以及变量集合与模板声明完全一致。缺少变量和未声明变量均拒绝发送。

### 7.5 发送执行

- 每次调用只允许一个接收手机号。
- OTP 走优先直发路径，不进入持久化普通短信队列，也不做自动重复发送。Better Auth 宿主可使用 `waitUntil` 或等价机制在响应外完成这次直接调用，但必须保留发送任务的执行承诺，并统一外部响应时序以降低账号枚举和时序侧信道风险。
- 普通事务短信先在同一事务中创建消息和任务；手机号密文及模板变量密文随消息保存，由 Worker 在租约期间按需解密后发送。OTP 变量不得进入该异步载荷。
- 相同业务幂等键不得创建重复短信。
- 只有供应商明确拒绝受理且明确标识为可重试的限流或暂时不可用响应，才允许指数退避和抖动，默认最多三次供应商调用。
- 网络超时、连接中断或进程崩溃导致“可能已经提交”的情况必须把 `acceptance_status` 标记为 `unknown`，先等待回执或补查，禁止自动重发。OutId 只用于业务关联，不视为供应商幂等键。
- 永久失败不重试；每次调用均记录独立 Attempt。

### 7.6 Better Auth 适配

- `sms-kit/better-auth` 是可选入口，Better Auth 作为可选 peer dependency。
- 适配 Better Auth Phone Number 插件的 `sendOTP` 和 `sendPasswordResetOTP`。
- 登录验证码映射到 `auth.login_otp`，找回密码映射到 `auth.password_reset`；映射允许宿主配置。
- 首版只允许已有账号登录，宿主不得启用 `signUpOnVerification`；手机号注册不属于本项目范围。
- 适配器要求宿主提供 `isExistingPhone` 服务端回调。未知手机号不发送真实短信，执行等价的固定成本处理并返回与已存在手机号相同的外部响应；安全审计不得暴露号码是否存在。
- Better Auth 自己生成并验证登录/找回密码 OTP，管理用户和会话。
- `sms-kit` 负责模板选择、发送、限流、脱敏记录、审计和统计。
- Better Auth 与宿主认证流程必须对不存在的手机号返回一致响应；`sms-kit` 适配器不得通过发送错误泄露账号是否存在。

### 7.7 修改密码与高风险操作 Challenge

- 通用 Challenge 绑定 `subjectId`、手机号哈希、`action`、用途和到期时间。
- 数据库不保存明文验证码，只保存带服务端 pepper 的哈希。
- 默认验证码长度为 6 位、有效期 5 分钟、最多验证 3 次。
- 验证成功签发随机、短时、单次使用的证明；数据库保存证明哈希。
- 证明绑定 `subjectId + action + challengeId`，不能跨用户、跨动作或重复使用。
- 当宿主业务数据与 `sms-kit` 使用同一 PostgreSQL 数据库时，必须通过 `SmsTransaction` 复用同一 `pg` 事务，使用条件更新消费证明并执行实际高风险操作。
- 不同数据库或无法共享事务时，宿主只能调用带业务幂等键的高风险操作，并采用“先条件消费证明、再执行幂等业务操作、失败可安全重放”的补偿契约。适配器必须显式声明所选模式，不能声称提供跨数据库原子性。

### 7.8 防刷与预算

- 同手机号、同用途：60 秒最多一次，1 小时最多 5 次，24 小时最多 10 次。
- 同一验证码最多验证 3 次，成功或超限后失效。
- IP 限流与手机号限流分离；客户端 IP 必须由宿主从可信代理链解析后传入。
- 提供可配置的全局每日发送预算和熔断开关。
- `RateLimitStore` 操作必须原子化，PostgreSQL 为参考实现。

### 7.9 受理、送达回执与补查

- 供应商 API 返回成功只记为 `accepted`，不能计为最终送达。
- HTTP 回调 Route Handler 支持阿里云连通性检查和批量状态推送，在 700ms 限制内返回要求的确认结构。
- 回调 URL 必须使用 HTTPS，并携带由宿主 Secret 引用提供的高熵路径令牌；处理器使用常量时间比较验证令牌，反向代理和应用日志必须屏蔽该路径段。令牌只降低非授权调用风险，不把回调提升为强来源证明。
- Handler 必须分别限制请求体字节数、批次数量、字段长度和解析时间。需要强确认的部署可以把回调视为状态提示，再通过 `QuerySendDetails` 复核终态。
- 回执先执行严格结构校验、字段限制、BizId/消息关联和幂等落库，再更新送达状态。
- 回调可能重复或乱序，状态机不得从终态回退到非终态。
- 无回执和处理异常的记录进入 `QuerySendDetails` 定时补查。
- 超过补查窗口仍无法确认的消息标记为 `unknown_final` 并产生告警事件。

### 7.10 发送记录与统计

明细至少展示：消息 ID、脱敏手机号、模板键、用途、提交时间、受理状态、送达状态、供应商 BizId、尝试次数和最终错误摘要。

统计至少支持按时间、模板键、用途和状态筛选，并分别提供：

- 提交次数
- 供应商受理次数与受理率
- 最终送达次数与送达率
- 最终失败次数
- 等待回执和最终未知次数
- 暂时失败重试次数

长期日统计不包含手机号或模板变量。

### 7.11 管理权限与审计

宿主负责认证和角色管理。`sms-kit` 定义并请求以下权限动作：

- `config.read`、`config.write`
- `resource.sync`、`signature.manage`、`template.manage`
- `sms.test`
- `message.read`、`stats.read`
- `receipt.reconcile`

所有配置保存、权限测试、真实测试发送、资源同步、模板键修改、启停和手动补查均写入脱敏审计事件，并记录 `actorId`。

## 8. 数据与隐私设计

详细设计见 `doc/数据库设计.md`。

- 手机号保存为密文、不可逆检索哈希、末四位和脱敏展示值。
- `PhoneNumberProtector` 由宿主实现或注入，包不持有固定加密密钥。
- OTP Challenge 和尝试记录默认 7 天后删除或匿名化。
- 消息明细和回执默认 90 天后清除手机号密文、检索哈希、末四位、脱敏展示值、可识别业务元数据及供应商原始载荷，仅保留不含个人信息的状态维度或日统计。
- 脱敏审计事件默认保存 180 天。
- 不含个人信息的日统计长期保留。
- 清理任务应分批、可恢复，并记录处理数量和失败摘要。

## 9. 错误模型与重试

公共 API 返回稳定领域错误码，供应商错误只作为脱敏诊断字段。错误分类至少包括：

- `CONFIG_INVALID`、`SECRET_UNRESOLVABLE`、`PERMISSION_DENIED`
- `SIGNATURE_UNAVAILABLE`、`TEMPLATE_UNAVAILABLE`、`TEMPLATE_VARIABLE_INVALID`
- `RATE_LIMITED`、`BUDGET_EXCEEDED`、`CIRCUIT_OPEN`
- `PROVIDER_REJECTED`、`PROVIDER_THROTTLED`、`PROVIDER_UNAVAILABLE`
- `IDEMPOTENCY_CONFLICT`、`CONCURRENT_MODIFICATION`
- `CHALLENGE_EXPIRED`、`CHALLENGE_ATTEMPTS_EXCEEDED`、`PROOF_INVALID`
- `ACCEPTANCE_UNKNOWN`、`DELIVERY_UNKNOWN`、`STORAGE_FAILURE`

只有供应商明确返回“未受理且可重试”的限流或暂时不可用错误允许自动重试。网络超时、连接中断和进程崩溃造成的受理未知不得自动重发，而是进入回执等待与补查。配置、权限、模板、参数和预算错误不得重试。

## 10. 后台任务

包提供任务函数和数据库租约，不绑定具体调度器：

- `send-worker`：普通短信发送与退避重试。
- `receipt-reconcile`：未知送达状态补查。
- `data-retention`：执行 7/90/180 天清理策略。
- `daily-rollup`：生成匿名日统计。
- `resource-sync`：手动为主，可由宿主选择定时检查云端变化。

所有任务必须支持批次上限、并发租约、重复执行和结构化结果摘要。自动任务使用明确的系统 Actor，例如 `system:send-worker`，不得伪装成管理员操作。

## 11. 管理端规范

管理端采用资源标签页：

1. 服务配置
2. 签名
3. 模板
4. 验证码
5. 回执与补查
6. 发送记录
7. 统计

UI 技术栈和交互规则见 `doc/前端开发规范.md`。可直接用于编码 Agent 的指令见 `doc/prompts/sms-kit-admin-ui.md`。

### 11.1 管理 API 与 DTO 契约

`sms-kit/next` 导出 Route Handler 工厂和 `sms-kit/next/types` DTO。宿主可以修改路由前缀，但不得改变 DTO 语义。建议路由前缀为 `/api/admin/sms`：

| 方法与路径 | 权限 | 主要 DTO |
| --- | --- | --- |
| `GET /overview` | 任一读取权限 | `SmsOverviewDto` |
| `GET/PATCH /config` | `config.read/config.write` | `ProviderConfigDto`、`UpdateProviderConfigInput` |
| `POST /config/test-connection` | `config.write` | `ConnectionTestResultDto` |
| `POST /config/test-send` | `sms.test` | `TestSendInput`、`MessageDto` |
| `POST /resources/sync-preview` | `resource.sync` | `ResourceSyncPreviewDto`，包含同步 ID、校验和和过期时间 |
| `POST /resources/sync-commit` | `resource.sync` | `ResourceSyncCommitInput`，必须回传候选 ID 与校验和 |
| `GET /signatures`、`PATCH /signatures/:id` | `config.read/signature.manage` | `PageDto<SignatureDto>`、`UpdateSignatureInput` |
| `GET /templates`、`POST /templates/import`、`PATCH /templates/:id` | `config.read/template.manage` | `PageDto<TemplateDto>`、`ImportTemplateInput`、`UpdateTemplateInput` |
| `GET/PATCH /verification` | `config.read/config.write` | `VerificationSettingsDto` |
| `GET /receipt-health` | `message.read` | `ReceiptHealthDto` |
| `POST /reconcile` | `receipt.reconcile` | `ReconcileInput`、`JobDto` |
| `GET /messages`、`GET /messages/:id` | `message.read` | `PageDto<MessageDto>`、`MessageDetailDto` |
| `GET /stats` | `stats.read` | `SmsStatsDto` |
| `GET /jobs/:id` | 发起操作对应权限 | `JobDto` |

所有成功响应使用 `{ data, requestId }`；列表使用 `{ data: { items, page, pageSize, total }, requestId }`。错误响应使用 `{ error: { code, message, fieldErrors?, retryable }, requestId }`，其中 `code` 必须来自稳定领域错误集合。写请求携带 `version` 和操作级 `idempotencyKey`；服务端拒绝未知字段。

Secret 引用 DTO 只包含 `{ scheme, maskedName, configured }`。手机号 DTO 只返回 `{ masked, last4Available }`。管理员在浏览器主动输入的完整测试号码或精确查询号码可以作为一次性 HTTPS 请求字段发送，但服务端不得回显，客户端不得持久化、缓存、分析或记录该值。

以下最小 TypeScript 结构是公共契约的一部分；具体资源 DTO 可以增加向后兼容字段，但不得改变已有字段语义：

```ts
type ApiSuccess<T> = { data: T; requestId: string };
type ApiFailure = {
  error: {
    code: SmsErrorCode;
    message: string;
    fieldErrors?: Record<string, string[]>;
    retryable: boolean;
  };
  requestId: string;
};
type PageDto<T> = {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
};
type SecretRefDto = {
  scheme: string;
  maskedName: string;
  configured: boolean;
};
type VersionedWrite = {
  version: number;
  idempotencyKey: string;
};
type ResourceCandidateDto = {
  id: string;
  resourceType: "signature" | "template";
  externalKey: string;
  changeType: "new" | "changed" | "unavailable" | "unchanged";
  checksum: string;
  expiresAt: string;
};
type MessageDto = {
  id: string;
  phone: { masked: string | null; last4Available: boolean };
  templateKey: string;
  purpose: string;
  acceptanceStatus: "pending" | "accepted" | "rejected" | "unknown";
  deliveryStatus: "not_applicable" | "waiting" | "delivered" | "failed" | "unknown_final";
  submittedAt: string;
  attemptCount: number;
  providerBizId?: string;
  finalErrorCode?: SmsErrorCode;
};
```

日期时间字段使用 ISO 8601 UTC 字符串；计数在 JSON 中使用安全整数范围内的 number，超出范围时改为十进制字符串并发布兼容版本说明。`SmsErrorCode`、资源状态、配置状态和 Job 状态由 `sms-kit/next/types` 集中导出。

## 12. 测试策略

### 12.1 默认测试

- Vitest 单元测试：变量校验、状态机、错误映射、幂等、限流、Challenge、脱敏和清理选择。
- Provider 契约测试：正常响应、明确拒绝、可安全重试的限流、受理未知的超时、重复/乱序回执和详情补查。
- Store 契约测试：事务、唯一约束、乐观锁、Worker 租约和原子限流。
- PostgreSQL 集成测试：Docker/Testcontainers 启动临时实例，执行迁移和种子数据。
- Better Auth 适配契约测试：确保输入映射和错误边界正确，不创建或修改认证会话。

### 12.2 真实阿里云联调

真实测试默认禁用，只有同时满足显式开关、全新最小权限凭据引用、白名单手机号、可用测试签名和模板时才允许运行。CI 不得默认运行真实联调。此前在对话中暴露的凭据不得使用，必须先在阿里云侧禁用和轮换。

## 13. 可观测性

- 结构化事件默认不包含完整手机号、Secret、OTP 或未经允许的模板变量。
- 就绪状态覆盖配置、权限、资源、回调新鲜度、任务积压和预算。
- 指标覆盖提交、受理、送达、失败、未知、耗时、重试和积压。
- 异常率、回调中断、长期未知、预算接近阈值和云端模板失效通过 `EventSink` 交给宿主告警。

## 14. 验收标准

1. 空 PostgreSQL 数据库可通过迁移进入目标版本，并通过存储契约测试。
2. 模拟环境可完成配置、权限测试、资源同步、导入、稳定键设置和启停。
3. 模板变量缺失、多余、模板停用和云端状态异常均在调用供应商前被拒绝。
4. 相同幂等键的并发请求只产生一条业务消息。
5. OTP 优先直发；普通短信由 Worker 使用加密模板变量异步发送，只重试明确未受理的暂时错误，受理未知不自动重发。
6. 重复或乱序回执不会重复计数，也不会让终态回退。
7. 补查可把等待状态更新为最终送达、最终失败或最终未知。
8. Better Auth 适配器可用于验证码免密登录与手机号找回密码的发送回调。
9. 高风险 Challenge 的证明绑定用户和动作，过期、超次和重复消费均失败。
10. 发送明细与统计口径一致，并分别展示受理与最终送达。
11. 日志、API 和管理端不泄露完整手机号、Secret 或 OTP。
12. 清理任务符合 7/90/180 天默认策略，匿名日统计保持可用。
13. 前端规范和 Prompt 能生成覆盖全部七个标签页、状态和权限的 Next.js 管理端。
14. 未知手机号不会自动注册、不会触发真实短信，且外部响应不泄露账号存在性。
15. 同步预览在过期或校验和变化后不能提交。
16. 同库模式下高风险证明消费与业务操作共享事务；跨库模式只允许幂等补偿契约。

## 15. 缺失功能分析结论

原始需求未明确但已纳入首版的必要能力包括：供应商受理与最终送达分离、受理未知禁止自动重发、HTTP 回执入口保护与幂等、定时补查、同步候选快照、模板变量严格校验、异步变量加密、业务幂等、普通短信安全重试、OTP 防刷、未知手机号防枚举、每日预算与熔断、手机号加密与脱敏、数据保留与清理、宿主鉴权与审计、高风险证明事务契约、后台任务租约、可观测性、数据库版本检查和真实联调保护。

以下能力明确推迟：多供应商、国际短信、多租户、批量营销、在线编辑云端模板、成本核算和内置告警渠道。未来增加这些能力时必须单独评审，不应破坏稳定模板键和核心 Ports。

## 16. 官方参考

- 阿里云 SendSms：<https://api.aliyun.com/document/Dysmsapi/2017-05-25/SendSms>
- 阿里云短信 OpenAPI 概览：<https://next.api.aliyun.com/document/Dysmsapi>
- 阿里云短信回执配置：<https://help.aliyun.com/zh/sms/developer-reference/configure-delivery-receipts-1/>
- 阿里云 QuerySendDetails：<https://next.api.aliyun.com/document/dysmsapi/2017-05-25/QuerySendDetails>
- Better Auth Phone Number：<https://better-auth.com/docs/plugins/phone-number>
- Better Auth 插件开发：<https://better-auth.com/docs/concepts/plugins>
