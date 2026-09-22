# auth-kit

`auth-kit` 是面向中国大陆手机号账号的私有认证包。它把密码登录、短信验证码登录、找回密码、登录态改密、退出、会话读取和四位图形验证码收敛到一个受保护的 HTTP 边界，并提供可选的 React 表单。短信验证码由 Better Auth 管理，短信提交通过宿主注入的 `sms-kit` `SendService` 完成。

包只处理认证流程。账号数据的首次准备、宿主授权策略、PostgreSQL 与 Redis 运维、`sms-kit` 配置和迁移执行均由宿主负责。

## 版本与安装

当前包固定使用以下版本：

| 项目 | 版本 |
| --- | --- |
| Node.js | `>=20.19` |
| auth-kit | `0.0.0` |
| sms-kit | `0.0.0` |
| Next.js | `16.3.5` |
| React / React DOM | `19.3.0` |
| Better Auth / adapter | `1.7.4` |
| pg | `8.23.0` |
| ioredis | `6.0.0` |

本仓库中的两个私有包应一起打包，并从本地 `.tgz` 一次安装到宿主：

```sh
npm install /path/sms-kit-0.0.0.tgz /path/auth-kit-0.0.0.tgz pg@8.23.0 ioredis@6.0.0 next@16.3.5 react@19.3.0 react-dom@19.3.0
```

不要把这两个私有包发布到公共 registry。宿主需要自行锁定上述直接依赖。

## 运行拓扑

一个应用使用一个独立认证 schema、一个稳定的 `appId` 和一份至少 32 字符的 `secret`。同一应用的所有副本必须共享完全相同的 `appId`、`secret`、PostgreSQL 数据库和 Redis；更改其中任一值会改变 Cookie、锁、限流和验证码命名空间。

PostgreSQL `Pool` 是必需依赖。认证请求使用每手机号的 PostgreSQL advisory lock 串行化关键写入。Redis 提供服务端时间、图形验证码、短信发送窗口和短信受理证明；Redis 异常时认证流程失败关闭，不会降级到进程内状态。

`baseURL` 必须是对外公开的精确 origin。生产环境使用 HTTPS；开发环境仅允许 HTTP loopback。默认 `basePath` 是 `/api/auth-kit`，自定义值必须以 `/` 开头且不能以 `/` 结尾。所有 POST 请求还会校验 `Origin`，宿主必须从可信基础设施解析客户端 IP，不能直接信任请求者提供的转发 Header。

## PostgreSQL schema

`auth-kit/schema` 提供两个运行时导出和一个类型：

| 导出 | 用途 |
| --- | --- |
| `createAuthSchema(namespace = "auth_kit")` | 创建供 Drizzle 和 `createAuthKit` 使用的表定义 |
| `authSchemaSql(namespace = "auth_kit")` | 生成空专用 namespace 的建表 SQL |
| `AuthSchema` | `createAuthSchema` 返回类型 |

namespace 只接受小写字母开头、最长 48 字符的字母数字下划线名称，并拒绝 `public`。

`createAuthKit` 不执行 SQL，也不自动迁移。宿主必须审查 `authSchemaSql()` 的结果，把它纳入自己的迁移流程，并且只在空的专用 namespace 执行。表包含 `user`、`session`、`account` 和 `verification`；不要让另一应用复用这些表。

## 完整服务端装配

下面的模块显式接收全部宿主依赖，并返回 `kit`、连接对象和生命周期关闭函数。`sms` 与 `tenantId` 必须来自宿主可信配置，不能来自浏览器请求。PostgreSQL 同时设置建连和语句超时；Redis 重试有界，连接与命令均有超时。生产 Redis TLS 由 `redisTls` 开启，证书策略仍由宿主部署环境负责。

```ts
import { Redis } from 'ioredis';
import { Pool, type PoolConfig } from 'pg';
import type { SendService } from 'sms-kit/application';
import type { TenantId } from 'sms-kit/core';
import {
  createAuthKit,
  type AuthKit,
  type RedisConnection,
} from 'auth-kit/server';
import { createAuthSchema } from 'auth-kit/schema';

export type HostAuthDependencies = {
  appId: string;
  baseURL: string;
  secret: string;
  pool: Pool;
  redis: RedisConnection;
  sms: Pick<SendService, 'sendOtpNow'>;
  tenantId: TenantId;
  resolveClientIp(request: Request): string | Promise<string>;
};

export function createHostAuth(host: HostAuthDependencies): AuthKit {
  return createAuthKit({
    appId: host.appId,
    baseURL: host.baseURL,
    secret: host.secret,
    pool: host.pool,
    redis: host.redis,
    schema: createAuthSchema('auth_kit'),
    sms: {
      sendService: host.sms,
      tenantId: host.tenantId,
      templates: {
        login: 'auth.login_otp',
        passwordReset: 'auth.password_reset',
      },
    },
    resolveClientIp: host.resolveClientIp,
  });
}

export type AuthRuntimeConfig = {
  appId: string;
  baseURL: string;
  secret: string;
  postgres: PoolConfig;
  redisHost: string;
  redisPort: number;
  redisUsername?: string;
  redisPassword?: string;
  redisTls: boolean;
  tenantId: TenantId;
};

export async function createAuthRuntime(
  config: AuthRuntimeConfig,
  sms: Pick<SendService, 'sendOtpNow'>,
  resolveClientIp: (request: Request) => string | Promise<string>,
) {
  const pool = new Pool({
    ...config.postgres,
    connectionTimeoutMillis: config.postgres.connectionTimeoutMillis ?? 5_000,
    statement_timeout: config.postgres.statement_timeout ?? 15_000,
  });
  const redis = new Redis({
    host: config.redisHost,
    port: config.redisPort,
    lazyConnect: true,
    enableReadyCheck: true,
    connectTimeout: 5_000,
    commandTimeout: 5_000,
    maxRetriesPerRequest: 1,
    retryStrategy: (attempt) => attempt <= 3 ? Math.min(attempt * 100, 1_000) : null,
    ...(config.redisUsername === undefined ? {} : { username: config.redisUsername }),
    ...(config.redisPassword === undefined ? {} : { password: config.redisPassword }),
    ...(config.redisTls ? { tls: { servername: config.redisHost } } : {}),
  });

  try {
    await redis.connect();
  } catch (error) {
    redis.disconnect();
    await pool.end();
    throw error;
  }

  const kit = createHostAuth({
    appId: config.appId,
    baseURL: config.baseURL,
    secret: config.secret,
    pool,
    redis,
    sms,
    tenantId: config.tenantId,
    resolveClientIp,
  });

  return {
    kit,
    pool,
    redis,
    async close(): Promise<void> {
      try {
        await redis.quit();
      } finally {
        await pool.end();
      }
    },
  };
}
```

Next.js App Router 的 catch-all Route Handler 必须运行在 Node.js Runtime，并把 GET 与 POST 原样交给同一个 `kit.handler(request)`。可运行的本地示例见 `examples/next/lib/auth.ts`，页面见 `examples/next/app/page.tsx` 与 `examples/next/app/account/change-password/page.tsx`。示例仅在 `AUTH_KIT_DEMO=1` 且 origin 为 loopback 时启动，并显式禁用短信 Mock：准备账号后可验证密码登录；短信页面必须由宿主替换成真实注入的 `SendService` 才能收到验证码。该示例不表示真实短信链路已经验证。

宿主还必须把 `examples/next/next.config.mjs` 中的服务端外置项合并进现有 Next 配置：

```js
export default {
  serverExternalPackages: ['sms-kit', 'svg-captcha', 'argon2'],
};
```

不要覆盖宿主原有的 `serverExternalPackages`，应合并并去重。这会让 `svg-captcha` 的字体资源和 `argon2` 原生运行时资源保留在 Node.js 包中，避免被 Next 服务端打包器错误内联或遗漏。不要把整个 `auth-kit` 外置；它同时包含 React 入口，外置会让预渲染加载另一份 React dispatcher。

生产装配通常把 runtime 保存为进程单例，并在进程关闭钩子中调用 `close()`；不要按请求新建连接池或 Redis 客户端。

`createAuthKit(options)` 的公开参数如下：

| 参数 | 类型、默认值与约束 |
| --- | --- |
| `appId` | 必填字符串；1–48 位字母、数字、下划线或连字符。副本间必须一致 |
| `baseURL` | 必填精确公开 origin；生产 HTTPS，开发可用 HTTP loopback |
| `basePath` | 可选字符串；默认 `/api/auth-kit`，以 `/` 开头且无尾斜杠 |
| `secret` | 必填字符串；至少 32 字符，副本间必须一致 |
| `pool` | 必填 `pg.Pool`，生命周期由宿主管理 |
| `schema` | 必填 `AuthSchema`，通常来自 `createAuthSchema()` |
| `redis` | 必填 `RedisConnection`；接口为 `eval(script, numberOfKeys, ...args): Promise<unknown>` |
| `sms.sendService` | 必填 `Pick<SendService, "sendOtpNow">` |
| `sms.tenantId` | 必填 `TenantId`，由宿主可信上下文注入 |
| `sms.templates.login` | 可选；默认 `auth.login_otp` |
| `sms.templates.passwordReset` | 可选；默认 `auth.password_reset` |
| `resolveClientIp` | 必填 `(request) => string \| Promise<string>` |
| `isUserAllowed` | 可选额外账号允许策略；基础 `enabled` 检查始终存在 |
| `verifyLegacyPassword` | 可选旧 pepper/预处理后备验证器；标准 Argon2id 先执行 |

返回的 `AuthKit` 包含 `handler(request): Promise<Response>` 与 `getSession(request): Promise<AuthSession | null>`。`handler` 是认证 HTTP 的唯一入口。

## 宿主准备账号数据

手机号的唯一规范化实现来自 `sms-kit/core` 的 `normalizeMainlandPhone`，存储值为中国大陆 E.164 格式，例如 `+8613800138000`。不要在宿主或前端复制另一套手机号规范化规则。

首次准备 credential 记录时，`user.email` 必须使用唯一的合成占位值 `` `${id}@auth.invalid` ``，只作为 schema 兼容字段；`phoneNumberVerified` 与 `enabled` 均为 `true`。对应 `account` 使用 `providerId: "credential"`，且 `accountId` 与 `userId` 都等于用户 ID。

下面的宿主事务同时覆盖新密码和受信任的既有 Argon2id hash。新密码只调用 `hashPassword()`；既有 hash 先在可信导入边界确认格式，然后按原字符串写入，不重新散列。

```ts
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { normalizeMainlandPhone } from 'sms-kit/core';
import { hashPassword } from 'auth-kit/server';
import { createAuthSchema } from 'auth-kit/schema';

type CredentialSource =
  | { kind: 'new-password'; password: string }
  | { kind: 'trusted-argon2id'; encodedHash: string };

export async function prepareCredentialUser(
  pool: Pool,
  input: { name: string; phoneNumber: string; credential: CredentialSource },
): Promise<{ id: string; phoneNumber: string }> {
  const schema = createAuthSchema('auth_kit');
  const id = randomUUID();
  const phoneNumber = normalizeMainlandPhone(input.phoneNumber);
  const password = input.credential.kind === 'new-password'
    ? await hashPassword(input.credential.password)
    : input.credential.encodedHash;

  if (input.credential.kind === 'trusted-argon2id' && !password.startsWith('$argon2id$')) {
    throw new TypeError('trusted credential must be an encoded Argon2id hash');
  }

  const db = drizzle(pool);
  await db.transaction(async (tx) => {
    await tx.insert(schema.user).values({
      id,
      name: input.name,
      email: `${id}@auth.invalid`,
      emailVerified: false,
      phoneNumber,
      phoneNumberVerified: true,
      enabled: true,
    });
    await tx.insert(schema.account).values({
      id: randomUUID(),
      accountId: id,
      providerId: 'credential',
      userId: id,
      password,
    });
  });

  return { id, phoneNumber };
}
```

包不导出账号维护服务；上述写入属于宿主首次准备流程。新密码规则为 8–128 字符，且至少包含一个英文字母和一个数字。标准 Argon2id 校验始终先执行；仅在标准校验失败时，`AuthKitOptions.verifyLegacyPassword` 才作为旧 pepper 或预处理格式的后备校验。它不会改变新密码统一使用 Argon2id 的规则。

## HTTP API

除 `/session` 外所有端点均为 POST、`Content-Type: application/json`，请求体最大 8192 字节。所有成功与错误响应都带 `Cache-Control: no-store`。默认前缀为 `/api/auth-kit`。

| 方法与路径 | 请求体 | 成功响应 | Cookie 行为 |
| --- | --- | --- | --- |
| `POST /captcha` | `{ purpose: "password-login" \| "sms-login" \| "password-reset" }` | `Captcha` | 设置/刷新 HttpOnly challenge Cookie |
| `POST /sms/send` | `SendSmsInput` | `SendSmsResult` | 使用 challenge Cookie；不创建登录态 |
| `POST /sign-in/password` | `PasswordLoginInput` | `AuthSuccess` | 成功后设置会话 Cookie |
| `POST /sign-in/sms` | `SmsLoginInput` | `AuthSuccess` | 成功后设置会话 Cookie |
| `POST /password/reset` | `ResetPasswordInput` | `AuthSuccess` | 撤销全部会话，不创建新会话 |
| `POST /password/change` | `ChangePasswordInput` | `AuthSuccess` | 撤销全部旧会话，并为当前请求返回新会话 Cookie |
| `POST /sign-out` | `{}` | `AuthSuccess` | 撤销当前会话并更新 Cookie |
| `GET /session` | 无 | `AuthSession` | HTTP 响应会透传 Better Auth 的滚动刷新 Cookie |

`Captcha` 的 `image` 是 SVG 字符串，`expiresAt` 与 `serverTime` 是 Unix 毫秒。`AuthSession.expiresAt` 是 ISO 日期字符串。四位图形验证码按应用、浏览器 challenge 上下文和用途绑定，刷新会使该用途的旧图失效；无论答案正确与否，一次验证尝试都会消费当前 challenge。

`kit.getSession(request)` 是服务端判断辅助方法，返回 `Promise<AuthSession | null>`。未认证时返回 `null`；其他基础设施异常会抛出 `AuthKitError`。它只返回 DTO，不能把滚动刷新 Cookie 写回浏览器，因此与 `GET /session` 的 HTTP 行为不同。

### 短信响应语义

`POST /sms/send` 对未知账号、停用账号、供应商拒绝和供应商超时统一返回：

```json
{"status":true,"retryAt":1760000060000,"serverTime":1760000000000}
```

这里的 `status: true` 表示请求已按统一安全策略处理，不是供应商受理回执，也不保证手机最终收到短信。`retryAt` 是 auth-kit 对该手机号的共享发送配额时间，不是运营商承诺。宿主配置的 `sms-kit` 模板状态、人工熔断、预算、租户/IP/手机号策略及投递限制仍可能拒绝真实发送。

只有 `sms-kit` 返回 `acceptanceStatus: "accepted"` 后，auth-kit 才在 Redis 写入一条不含验证码的受理证明，TTL 与 Better Auth 原生 OTP 到期时间一致。验证码验证同时要求 Better Auth 原生记录和该证明有效。发送进程崩溃、受理失败或数据库清理失败时，仅残留原生记录也不能通过验证；Redis 异常同样失败关闭。重新发送会使上一条验证码及其证明失效。

### 密码与会话事务

密码更新以及首次创建 credential password 与服务端会话撤销在同一数据库事务中提交。事务任一部分失败时不会留下“密码已改但会话未撤销”或相反的中间状态。

改密先验证当前会话与当前密码，随后撤销所有会话，并在成功响应中为当前请求重建会话 Cookie。重置密码撤销全部会话且不自动恢复登录态，用户必须重新登录。退出会撤销当前服务端会话。

### 默认安全窗口

| 操作 | 默认限制 |
| --- | --- |
| 图形验证码 | 每 IP 60 次/60 秒；每应用 1000 次/60 秒；有效期 120 秒 |
| 密码登录 | 每 IP 100 次/滚动 300 秒；每手机号 10 次/滚动 300 秒 |
| 短信登录或重置验证 | 每 IP 100 次/滚动 300 秒；每手机号 15 次/滚动 300 秒 |
| 发送短信 | 每 IP 30 次/滚动 300 秒；同一手机号最短间隔 60 秒，滚动 300 秒最多 3 次，登录与重置共享 |
| 登录态改密 | 每 IP 30 次/滚动 300 秒 |
| 短信验证码 | 6 位数字；有效期 300 秒；最多 3 次尝试 |

这些是 auth-kit 自身的防护；`sms-kit` 仍会执行其独立策略。限流时间使用 Redis 服务端时间，多个副本共享且原子更新。

短信发送预留后，从 `sms-kit` 返回并完成安全状态收尾时才以完成时刻计算下一次 60 秒冷却。若进程在收尾前终止，Redis 中的 pending fence 最长阻止该手机号再次发送 360 秒，即原生 OTP 的 300 秒有效期再加 60 秒安全余量；系统不会自动重发。

## 浏览器客户端

`auth-kit/react` 的 `createAuthClient(options?)` 默认请求 `/api/auth-kit`，也接受 `basePath` 与注入的 `fetch`。所有请求使用 `credentials: "same-origin"`。方法直接使用根入口 `auth-kit` 的浏览器安全类型：

| 方法 | 参数 | 返回 |
| --- | --- | --- |
| `captcha` | `CaptchaPurpose` | `Promise<Captcha>` |
| `sendSms` | `SendSmsInput` | `Promise<SendSmsResult>` |
| `signInPassword` | `PasswordLoginInput` | `Promise<AuthSuccess>` |
| `signInSms` | `SmsLoginInput` | `Promise<AuthSuccess>` |
| `resetPassword` | `ResetPasswordInput` | `Promise<AuthSuccess>` |
| `changePassword` | `ChangePasswordInput` | `Promise<AuthSuccess>` |
| `signOut` | 无 | `Promise<AuthSuccess>` |
| `getSession` | 无 | `Promise<AuthSession>` |

HTTP `>=400` 且返回有效 `AuthFailure` 时会抛出 `AuthClientError`。该类公开 `code`、可选 `retryAt`、`serverTime` 和原始 `failure`；网络、非 JSON 或畸形错误响应统一映射为 `UNAVAILABLE`。

```ts
import { AuthClientError, createAuthClient } from 'auth-kit/react';

const auth = createAuthClient();

export async function readCurrentSession() {
  try {
    return await auth.getSession();
  } catch (error) {
    if (error instanceof AuthClientError && error.code === 'UNAUTHENTICATED') {
      return null;
    }
    throw error;
  }
}
```

## React 表单

最小页面可以直接使用公开子路径：

```tsx
import { AuthForms } from 'auth-kit/react';

export default function SignInPage() {
  return <AuthForms />;
}
```

`AuthFormsProps`：

| 属性 | 类型与默认值 |
| --- | --- |
| `client` | 可选 `AuthClient`；省略时内部创建客户端 |
| `basePath` | 可选字符串；默认 `/api/auth-kit` |
| `fetch` | 可选 `typeof fetch` |
| `initialView` | `"login" \| "reset-password" \| "change-password"`；默认 `"login"` |
| `className` | 添加到根节点的宿主 class |
| `onSuccess` | `(action: "sign-in" \| "password-reset" \| "password-change") => void` |

默认界面是密码登录，可切换短信登录并进入找回密码；`initialView="change-password"` 用于已认证页面。组件有持久标签、键盘可用按钮、焦点样式、`aria-live` 错误/状态、忙碌禁用和窄屏布局。图形验证码 SVG 会编码为 `img` data URL，不注入原始 HTML。

短信发送后，组件使用服务端时间修正本地倒计时：`localDeadline = Date.now() + max(0, retryAt - serverTime)`，初始显示 `已发送(60)`。同一规范手机号的短信登录与密码重置共享倒计时，`13800138000` 与 `+8613800138000` 视为同一手机号。密码、手机号和验证码只保存在组件内存中，不写入 URL、浏览器存储或日志。

内置样式使用 `.auth-kit` 范围和 `--auth-kit-*` CSS 自定义属性；宿主可通过 `className` 和变量覆盖外观。

## 公共类型与错误

根入口 `auth-kit` 仅导出浏览器安全类型：`CaptchaPurpose`、`SmsPurpose`、`AuthErrorCode`、`AuthFailure`、`Captcha`、`CaptchaAnswer`、`SendSmsInput`、`SendSmsResult`、`PasswordLoginInput`、`SmsLoginInput`、`ResetPasswordInput`、`ChangePasswordInput`、`AuthSession`、`AuthSuccess`。

| 类型 | 完整字段 |
| --- | --- |
| `CaptchaPurpose` | `"password-login" \| "sms-login" \| "password-reset"` |
| `SmsPurpose` | `"sms-login" \| "password-reset"` |
| `AuthErrorCode` | 下表列出的九个稳定错误码联合 |
| `AuthFailure` | `{ error: { code: AuthErrorCode; message: string }; retryAt?: number; serverTime: number }` |
| `Captcha` | `{ id: string; image: string; expiresAt: number; serverTime: number }` |
| `CaptchaAnswer` | `{ captchaId: string; captchaAnswer: string }` |
| `SendSmsInput` | `CaptchaAnswer & { phoneNumber: string; purpose: SmsPurpose }` |
| `SendSmsResult` | `{ status: true; retryAt: number; serverTime: number }` |
| `PasswordLoginInput` | `CaptchaAnswer & { phoneNumber: string; password: string }` |
| `SmsLoginInput` | `{ phoneNumber: string; code: string }` |
| `ResetPasswordInput` | `{ phoneNumber: string; code: string; newPassword: string }` |
| `ChangePasswordInput` | `{ currentPassword: string; newPassword: string }` |
| `AuthSession` | `{ user: { id: string; name: string; phoneNumber: string }; expiresAt: string }` |
| `AuthSuccess` | `{ status: true }` |

稳定错误码如下：

| 错误码 | 常见 HTTP 状态 | 含义 |
| --- | --- | --- |
| `INVALID_INPUT` | 400 | JSON、手机号、密码规则或字段无效 |
| `INVALID_CREDENTIALS` | 401 | 密码凭据无效或当前不能登录 |
| `CAPTCHA_INVALID` | 400 | 图形验证码无效、已消费、过期或用途不匹配 |
| `OTP_INVALID` | 400 | 短信验证码无效、过期、次数耗尽或无有效受理证明 |
| `RATE_LIMITED` | 429 | auth-kit 限流；响应可含 `retryAt` 与 `Retry-After` |
| `UNAUTHENTICATED` | 401 | 缺少有效会话 |
| `FORBIDDEN` | 403 | 来源或受保护调用边界不允许请求 |
| `UNAVAILABLE` | 503 | PostgreSQL、Redis、短信或内部依赖不可用 |
| `NOT_FOUND` | 404 | 路径或方法不在公开边界内 |

错误体统一为 `{ error: { code, message }, retryAt?, serverTime }`，时间戳是 Unix 毫秒。服务端还导出 `AuthKitError`，供宿主识别服务端错误；不要把 `auth-kit/server` 或 `auth-kit/schema` 导入 Client Component，browser export condition 会主动阻止此类打包。

`auth-kit/server` 的其余公开函数是：

- `hashPassword(password): Promise<string>`：校验新密码策略后生成 Argon2id hash。
- `verifyPassword({ hash, password }): Promise<boolean>`：验证标准 Argon2id hash，不把新密码策略套到旧密码登录。
- `validatePassword(password): void`：校验 8–128 字符、英文字母和数字规则。
- `createAuthKit(options): AuthKit`：创建唯一公开 HTTP 边界与服务端会话辅助方法。

## 验证命令

```sh
npm run build -w auth-kit
npm run typecheck -w auth-kit
npm test -w auth-kit
npm run test:pack -w auth-kit
```

测试需要 Docker 可启动 PostgreSQL 18，并且本机可执行 `redis-server` 7。`test:pack` 会打包 `sms-kit` 与 `auth-kit`，在临时宿主中从两个 `.tgz` 一起安装，检查公开导入、全部文档 TypeScript/TSX 片段、Next.js 生产构建，并用真实 PostgreSQL、Redis、Better Auth、`sms-kit` 服务、加密和迁移资产跑认证冒烟流程。仅供应商网络边界使用明确标记的 Mock，不调用真实供应商，因此测试通过不能作为真实短信已验证的证据。

打包冒烟同时覆盖真实 `SendService` 的登录与重置模板发送：供应商 Mock 捕获由 Better Auth 生成的六位验证码，再通过公开认证入口核验。短信登录检查错误码、用途隔离、并发仅一次成功、消费后复用失败、会话建立及退出撤销；短信重置检查改密与旧会话失效。测试手机号仅用于 Mock，不发送真实短信。
