---
title: sms-kit AI usage guide
package: sms-kit
package_version: 0.0.0
runtime: Node.js >=20, ESM
status: private workspace package; not published by this repository
source_of_truth:
  - package.json
  - src/*/index.ts
  - README.md
---

# sms-kit：AI 集成说明

本文面向编码代理和其他 AI 工具。目标是在不猜测 API、不降低安全边界的前提下，把 `sms-kit` 接入 Node.js 或 Next.js 服务。

## 1. 使用契约

开始修改宿主项目之前，遵守以下约束：

- **MUST** 使用 Node.js 20 或更高版本和 ESM。
- **MUST** 从拥有该能力的公开子路径导入；根入口 `sms-kit` 不导出运行时实现。
- **MUST** 把 `application`、`security`、`postgres`、`aliyun`、`better-auth`、`next` 和 `testing` 视为服务端入口。
- **MUST** 从可信的服务端会话或业务记录取得 tenant、actor、角色、IP 和收件人，不能信任请求体、查询参数或任意请求头中的这些值。
- **MUST** 保存密钥引用，而不是密钥值；不得记录明文凭据、手机号、OTP、模板变量、回调 token 或 provider 原始载荷。
- **MUST** 先执行数据库迁移，再接受请求或运行 worker。
- **MUST** 通过 `SendService` 发送业务通知或 OTP；不要直接调用 provider 绕过持久化、幂等、限流和审计。
- **MUST NOT** 从 Client Component 或其他浏览器代码导入服务端入口。
- **MUST NOT** 自动运行 `npm publish` 或阿里云 live 测试。
- **SHOULD** 先读取导出的依赖类型，再在宿主组合根中构造服务；不要猜测构造参数。

## 2. 当前能力和非能力

当前实现包含：

- PostgreSQL 存储和受控迁移；
- 阿里云短信 provider、资源发现/同步、发送回执和状态查询；
- 业务通知、测试短信、OTP、挑战与 proof、限流、预算和熔断；
- worker、发送恢复、状态对账、统计、健康检查和数据保留；
- Better Auth 手机号回调适配；
- Next.js 管理 API、回执 Handler 和调度任务 Handler；
- Node/Vitest 测试辅助工具。

当前不包含：

- 公共 npm registry 发布配置；`package.json` 设置了 `"private": true`；
- 内置 Vault、HTTP 或云密钥管理器客户端；只有 `EnvSecretResolver` 是内置解析器；
- 自动创建或迁移 Better Auth 用户手机号字段；
- 浏览器端 SDK 或 UI。

## 3. 安装与依赖来源

在本 monorepo 中使用 workspace 依赖：

```json
{
  "dependencies": {
    "sms-kit": "*"
  }
}
```

上面的 `*` 由根目录 npm workspace 解析为当前本地包；不要把它理解为允许从公共 registry 获取任意版本。

只有在组织已经把包发布到私有 registry 或配置为 Git/文件依赖后，才可使用对应的远端安装方式。当前仓库本身未配置可发布的私有 registry，因此不要假设下面的命令现在能从网络安装：

```sh
npm install sms-kit
```

宿主启用 Better Auth 适配时安装兼容版本的 `better-auth`。宿主还负责提供 PostgreSQL 连接、运行时密钥和调度设施。

## 4. 入口选择

| 任务 | 导入入口 | 可进入浏览器包 |
| --- | --- | --- |
| 领域值、错误和状态 | `sms-kit/core` | 是 |
| provider、存储、安全和运行时接口 | `sms-kit/ports` | 是，但优先 `import type` |
| 应用服务 | `sms-kit/application` | 否 |
| 加密、哈希、环境变量密钥解析 | `sms-kit/security` | 否 |
| PostgreSQL 迁移和存储 | `sms-kit/postgres` | 否 |
| 阿里云 provider | `sms-kit/aliyun` | 否 |
| Better Auth 适配器 | `sms-kit/better-auth` | 否 |
| Next.js handlers | `sms-kit/next` | 否 |
| Next.js 管理 DTO/Zod schema | `sms-kit/next/types` | 是，优先 `import type` |
| 测试 fixture 和 store contract | `sms-kit/testing` | 否 |

正确：

```ts
import { SendService } from "sms-kit/application";
import type { SecretResolver } from "sms-kit/ports";
import type { ApiSuccess, SmsOverviewDto } from "sms-kit/next/types";
```

错误：

```ts
import { SendService } from "sms-kit";
```

## 5. 推荐集成顺序

按以下顺序实现，避免形成未迁移、未加密或绕过策略的发送路径：

1. 建立 PostgreSQL `Pool`，在部署阶段调用 `migrateSmsKit(pool)`。
2. 创建 `PgSmsStore`，由宿主管理 Pool 生命周期。
3. 提供 `SecretResolver`、AES keyring 和至少 32 字节的 HMAC key。
4. 创建加密器、hasher 和阿里云 provider。
5. 在宿主组合根中按导出的 `*Dependencies` 类型构造应用服务。
6. 配置 provider 引用、验证策略、签名和模板映射。
7. 挂载管理、回执和调度 handlers。
8. 启动 worker、恢复、对账、rollup 和 retention 调度。
9. 用 fake provider 和包内测试工具验证；live 测试必须单独显式启用。

### PostgreSQL 初始化

```ts
import { Pool } from "pg";
import { migrateSmsKit, PgSmsStore } from "sms-kit/postgres";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await migrateSmsKit(pool);
const store = new PgSmsStore(pool);
```

不要把包内 SQL 复制到宿主迁移中。`migrateSmsKit` 自己维护 ledger、事务和 advisory lock。

## 6. 密钥与远端引用

`SecretResolver` 是宿主扩展点：

```ts
import type { SecretResolver } from "sms-kit/ports";

export class HostSecretResolver implements SecretResolver {
  async resolve(reference: string): Promise<string> {
    // 在这里校验允许的 scheme/path，并调用宿主已有的密钥管理器。
    // 返回值只用于当前操作；不要缓存或记录。
    return resolveFromTrustedSecretManager(reference);
  }
}
```

内置环境变量实现只接受 `env://UPPERCASE_NAME`：

```ts
import { EnvSecretResolver } from "sms-kit/security";

const secretResolver = new EnvSecretResolver(process.env);
// 配置中保存 env://ALIYUN_ACCESS_KEY_ID，而不是真实 AccessKey。
```

远端引用规则：

- 自定义 resolver 可以支持 `vault://...`、云 KMS 标识或其他宿主定义格式。
- `sms-kit` 不负责下载或安装远端 resolver，也不内置网络密钥客户端。
- resolver 必须 fail closed，限制允许的 scheme/namespace，并避免在异常中包含 secret。
- provider 配置只保存 `accessKeyIdRef`、`accessKeySecretRef` 和 `receiptCallbackTokenRef`。

加密组件从 `sms-kit/security` 导入：

```ts
import {
  AesGcmMessagePayloadProtector,
  AesGcmPhoneNumberProtector,
  HmacHasher,
  type AesKeyring,
} from "sms-kit/security";

const keyring: AesKeyring = hostManagedAesKeyring;
const hasher = new HmacHasher(hostManagedThirtyTwoByteHmacKey);
const phoneProtector = new AesGcmPhoneNumberProtector(keyring, hasher);
const payloadProtector = new AesGcmMessagePayloadProtector(keyring);
```

保护上下文会把 tenant、record、用途和字段绑定为 authenticated data。直接使用 protector 时不得跨租户、消息或字段复用密文或上下文。

## 7. Provider、资源和发送

创建阿里云 provider：

```ts
import { createAliyunProvider } from "sms-kit/aliyun";

const provider = createAliyunProvider({ secretResolver });
```

使用 `ConfigService` 保存 region、可选 endpoint 和密钥引用。endpoint 必须是无凭据的 HTTPS origin；不得包含 userinfo、非根路径、query 或 fragment。

模板同步必须是人工选择的两阶段流程：

1. `ResourceSyncService.preview()` 获取短期候选快照。
2. 新模板必须显式导入并指定稳定的 local key、purpose 和 signature。
3. `/resources/sync-commit` 只提交选中的签名及仍保持精确映射的已有模板。
4. 不得持久化任意 provider listing，也不得复用过期 checksum。

发送业务通知：

```ts
await sendService.enqueueNotification({
  tenantId: trustedTenantId,
  templateKey: "notice.shipped",
  phone: phoneFromTrustedBusinessRecord,
  variables: { orderNumber: order.id },
  purpose: "order.shipped",
  idempotencyKey: `order-shipped:${order.id}`,
});
```

`tenantId`、手机号和幂等键都应由可信应用层生成。provider 接受短信不等于最终送达；保留 acceptance 和 delivery 两套状态。

## 8. Next.js 接入

敏感 Route Handler 使用 Node runtime：

```ts
// app/api/admin/sms/[...path]/route.ts
export const runtime = "nodejs";

import { createSmsAdminHandler } from "sms-kit/next";

const handler = createSmsAdminHandler({
  basePath: "/api/admin/sms",
  resolveActor: resolveTrustedActor,
  resolveTrustedIp: resolveTrustedProxyIp,
  authorizer: smsAuthorizer,
  csrfProtection: {
    allowedOrigins: ["https://admin.example.com"],
    verifyToken: verifyHostCsrfToken,
  },
  services: smsAdminServices,
  ids,
});

export const GET = handler;
export const POST = handler;
export const PATCH = handler;
```

安全要求：

- `resolveActor` 和 `resolveTrustedIp` 是宿主安全边界。
- 有请求体的管理路由只接受 `application/json`。
- cookie 认证写请求必须通过同源检查或宿主绑定 session 的 CSRF token 检查。
- 默认只要请求含 cookie 就 fail closed；不要用攻击者可控的 `Authorization` header 关闭 CSRF。
- DTO 从 `sms-kit/next/types` 导入，不要为前端复制一套漂移的类型。

阿里云回执使用独立公共路由和高熵 path token：

```ts
import { createAliyunReceiptHandler } from "sms-kit/next";

const handler = createAliyunReceiptHandler({
  receiptService,
  clock,
  verifyToken: verifyReceiptPathToken,
});
```

token 校验必须恒定时间完成，并在读取 body 前执行。代理和应用日志必须遮盖 URL 最后一个 token path segment。

调度入口使用 `createSmsTaskHandler()`，只允许 `smsScheduledTaskNames` 中预声明的无 body POST 任务。调度器不得从请求中接受 tenant、worker payload 或任意方法名。

## 9. Better Auth

`better-auth` 是可选 peer dependency。使用 `createBetterAuthSmsAdapter()` 创建 `sendOTP` 和 `sendPasswordResetOTP` 回调。

AI 集成时必须保留以下条件：

- tenant 和 IP 从可信服务端上下文解析；
- 登录/重置短信只允许发送给租户内已存在的账号手机号；
- `resolveOtpIssuance` 返回当前精确验证记录的稳定、持久且唯一的 `{ id, expiresAt }`；
- Better Auth 实例构造时读取 OTP 长度、TTL 和尝试次数；这些值运行时变化后，宿主必须按自身配置生命周期重建实例；
- sms-kit 迁移不会创建或回填 Better Auth 用户手机号字段。

完整适配示例和密码重置 guard 见 [`README.md`](./README.md#better-auth-phone-number-callbacks)。

## 10. 后台任务与状态语义

宿主应调度以下能力：

- `SendWorker.runBatch()`：租约并发送已排队通知；
- `DispatchRecoveryService.runBatch()`：把废弃 dispatch 保守标为 acceptance unknown，不重发；
- `ReconcileService.runBatch()`：查询最终送达状态，不作为第二发送路径；
- `MaintenanceService.rollupDirtyDates()`：汇总统计；
- `MaintenanceService.applyRetention()`：应用保留策略。

状态不能合并：

- acceptance：`pending | accepted | rejected | unknown`
- delivery：`not_applicable | waiting | delivered | failed | unknown_final`

对账资格根据权威 attempt 的 `dispatchMarkedAt` 和 `Asia/Shanghai` 日历计算，最多查询当前日期及之前 29 个日期。历史缺失、矛盾或未来时间必须延迟为存储故障，不能猜测日期。

## 11. 测试与完成条件

默认测试不会联系阿里云：

```sh
npm test --workspace sms-kit
npm run typecheck --workspace sms-kit
npm run build --workspace sms-kit
```

测试宿主 store 或服务时可使用：

```ts
import {
  FakeClock,
  SequenceIdGenerator,
  createSafeMessageFixture,
  runSmsStoreContract,
} from "sms-kit/testing";
```

优先运行覆盖整个变更路径的合并测试，避免为每个小分支重复启动测试。只有用户明确要求并且专用凭据已就绪时，才能运行 `test:live` 或 `test:live:connection`。

完成集成前检查：

- [ ] 所有服务端导入均未进入浏览器 bundle。
- [ ] 部署阶段已运行迁移。
- [ ] 数据库、密钥、scheduler 和 actor/IP resolver 均由宿主持有。
- [ ] 没有明文密钥、手机号、OTP 或模板变量进入存储、响应或日志。
- [ ] 通知通过 `SendService`，回执和对账不会触发重复发送。
- [ ] 幂等键稳定且由可信业务对象生成。
- [ ] 管理写操作有 JSON、授权和 CSRF 边界。
- [ ] 默认测试、typecheck 和 build 通过；live 测试没有被意外执行。

## 12. AI 执行模板

把下面的指令与具体任务一起提供给编码代理：

```text
你正在集成私有 ESM 包 sms-kit（Node.js >=20）。
先读取 sms-kit/AI_USAGE.md、sms-kit/package.json 的 exports，以及所用入口的 .d.ts。
只从公开子路径导入，不从根入口猜测 API，不导入 src/ 内部文件。
保持 tenant/actor/IP/手机号来源可信；只保存 secret reference，不保存或记录 secret。
业务通知必须走 SendService；先迁移数据库，再挂载 API 或 worker。
Next.js 服务端实现从 sms-kit/next 导入，前端 DTO 从 sms-kit/next/types 导入。
先写出依赖组合和安全边界，再实现；最后运行 sms-kit 的默认测试、typecheck 和 build。
不得执行 npm publish 或任何 live 阿里云测试，除非用户明确授权。
```

## 13. 继续查证

当本文与代码不一致时，按以下优先级判断：

1. `package.json#exports`：允许导入的公共入口；
2. 对应入口生成的 `.d.ts` 或 `src/*/index.ts`：当前符号和类型；
3. [`README.md`](./README.md)：完整安全语义、路由和运行说明；
4. 本文：AI 工作流和快速选择指南。

不要导入未由 `package.json#exports` 暴露的 `src/` 或 `dist/` 深层路径。
