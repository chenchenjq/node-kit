# auth-kit AI 使用说明

本文件供生成或修改宿主集成代码的 AI 使用。以 `README.md`、`package.json` 和公开 `.d.ts` 为事实来源；不要导入 `src/` 文件或内部 Better Auth 实例。

## 固定环境

- Node.js `>=20.19`
- Next.js `16.3.5`
- React / React DOM `19.3.0`
- Better Auth `1.7.4`
- pg `8.23.0`
- ioredis `6.0.0`
- `auth-kit` 与 `sms-kit` 均为私有 `0.0.0` 包，使用本地 `.tgz` 一起安装

安装命令：

```sh
npm install /path/sms-kit-0.0.0.tgz /path/auth-kit-0.0.0.tgz pg@8.23.0 ioredis@6.0.0 next@16.3.5 react@19.3.0 react-dom@19.3.0
```

## 只使用这些公开入口

| 入口 | 可用内容 | 运行位置 |
| --- | --- | --- |
| `auth-kit` | 浏览器安全 DTO 类型 | 任意位置，客户端使用 `import type` |
| `auth-kit/react` | `createAuthClient`、`AuthClientError`、`AuthForms` 及其类型 | Client Component 或浏览器安全模块 |
| `auth-kit/server` | `createAuthKit`、服务端类型、密码函数、`AuthKitError` | Node.js 服务端 |
| `auth-kit/schema` | `createAuthSchema`、`authSchemaSql`、`AuthSchema` | Node.js 服务端或迁移工具 |

不得从 `auth-kit` 内部路径导入，不得把 server/schema 子路径带进 Client Component。

## API 参数、返回值与默认配置

`createAuthKit(options: AuthKitOptions): AuthKit` 在配置错误时同步抛出 `Error`。配置如下；未标默认值的字段必须由宿主提供。

| 参数 | 类型与默认值 |
| --- | --- |
| `appId` | 1–48 位字母、数字、下划线或连字符 |
| `baseURL` / `basePath` | 精确 origin / 默认 `/api/auth-kit` |
| `secret` | 至少 32 字符的服务端密钥 |
| `pool` / `schema` | `pg.Pool` / `createAuthSchema()` 返回的表实例 |
| `redis` | `RedisConnection`，实现 `eval(script, numberOfKeys, ...args): Promise<unknown>`；无内存后备 |
| `sms.sendService` / `sms.tenantId` | `Pick<SendService, "sendOtpNow">` / `sms-kit/core` 的 `TenantId` |
| `sms.templates.login` | 可选，默认 `auth.login_otp` |
| `sms.templates.passwordReset` | 可选，默认 `auth.password_reset` |
| `resolveClientIp` | `(request: Request) => string \| Promise<string>`，必须提供可信客户端 IP |
| `isUserAllowed` | 可选，`({ id, phoneNumber, enabled }) => boolean \| Promise<boolean>`；只能在 `enabled` 检查上增加限制 |
| `verifyLegacyPassword` | 可选，`({ hash, password }) => Promise<boolean>`；标准验证失败后的后备 |
| `wechat` | 可选，仅接受 `{ enabled?: false }`；默认关闭，无扫码能力 |

`kit.handler(request)` 返回 `Promise<Response>`，错误已经转换为下文 HTTP 错误体。`kit.getSession(request)` 返回 `Promise<AuthSession | null>`；基础设施失败抛 `AuthKitError`。`AuthKitError(code, status, retryAt?)` 具有同名只读属性及安全 `message`。

`createAuthSchema(namespace?: string): AuthSchema` 与 `authSchemaSql(namespace?: string): string` 默认 namespace 均为 `auth_kit`；只接受非 `public` 的小写专用 namespace（最多 48 字符）。前者返回 `user/session/account/verification` Drizzle 表；后者返回建表 SQL，均不执行迁移。`validatePassword(password: string): void` 不合规则抛 `Error`；`hashPassword(password: string): Promise<string>` 统一校验并生成 Argon2id；`verifyPassword({ hash, password }): Promise<boolean>` 校验既有 Argon2id。

`createAuthClient(options?: { basePath?: string; fetch?: typeof fetch }): AuthClient` 默认使用 `/api/auth-kit` 与全局 `fetch`。方法均返回 Promise，失败抛 `AuthClientError`，具有 `code/message/retryAt?/serverTime/failure`。参数字段均为字符串，除 `purpose` 使用下文用途联合外：

| 方法 | 参数 | Promise 成功值 |
| --- | --- | --- |
| `captcha` | `purpose: CaptchaPurpose` | `{ id, image, expiresAt, serverTime }`，图像为 SVG 字符串，不含答案 |
| `sendSms` | `{ phoneNumber, purpose, captchaId, captchaAnswer }` | `{ status: true, retryAt, serverTime }` |
| `signInPassword` | `{ phoneNumber, password, captchaId, captchaAnswer }` | `{ status: true }` |
| `signInSms` | `{ phoneNumber, code }` | `{ status: true }` |
| `resetPassword` | `{ phoneNumber, code, newPassword }` | `{ status: true }` |
| `changePassword` | `{ currentPassword, newPassword }` | `{ status: true }` |
| `signOut` | 无 | `{ status: true }` |
| `getSession` | 无 | `{ user: { id, name, phoneNumber }, expiresAt }`；未认证时抛错，不返回 null |

固定服务端保护不可由客户端配置：图形获取每 IP 60 次/60 秒、每应用 1000 次/60 秒；密码尝试每 IP 100 次/300 秒、每手机号 10 次/300 秒；短信核验每 IP 100 次/300 秒、每手机号 15 次/300 秒；发送每 IP 30 次/300 秒；改密每 IP 30 次/300 秒。手机号发送总额度与验证码默认值见下文。

## 生成服务端集成时必须保持的约束

1. 一个应用只用一个专用 auth schema。所有副本共享同一 `appId`、至少 32 字符的 `secret`、PostgreSQL 和 Redis。
2. 宿主传入真实 `Pool`，设置 PostgreSQL 建连与 `statement_timeout`，不要在请求处理器中创建连接池。宿主创建 ioredis 6 客户端并负责 TLS、连接/命令超时、有界重试、启动连接和进程关闭。
3. `baseURL` 是精确公开 origin；生产使用 HTTPS。默认 `basePath` 是 `/api/auth-kit`。
4. `resolveClientIp(request)` 必须来自可信代理或平台上下文。不要直接读取并信任请求者传入的 `x-forwarded-for` 或 `x-real-ip`。
5. `sms.sendService` 是宿主已有 `SendService` 的 `sendOtpNow` 能力；`tenantId` 与模板键从宿主可信配置注入，绝不从请求体、查询参数或自定义 Header 获取。
6. 只使用 `sms-kit/core` 的 `normalizeMainlandPhone` 做手机号规范化。数据库存中国大陆 E.164 值。
7. 调用 `authSchemaSql()` 只生成 SQL；让宿主审查并通过自身迁移系统在空专用 namespace 执行。不要在应用启动或请求路径自动执行 SQL。
8. Next catch-all Route Handler 使用 Node.js Runtime，并将 GET/POST `Request` 原样交给同一 `kit.handler`。
9. `kit.getSession(request)` 未认证时返回 `null`，但不会把滚动刷新 Cookie 写回响应。需要浏览器接收刷新 Cookie 时调用公开 `GET /session` HTTP 端点。
10. 将 `sms-kit`、`svg-captcha`、`argon2` 合并进 Next `serverExternalPackages`。保留宿主已有项目。不要外置整个 `auth-kit`，否则其 React 入口可能在预渲染时加载另一份 dispatcher。

可运行的本地装配位于 `examples/next/lib/auth.ts`；它要求 `AUTH_KIT_DEMO=1`、loopback origin、`AUTH_SECRET`、`DATABASE_URL` 与 `REDIS_URL`。其中短信 Mock 明确抛错且不记录 OTP：账号准备后只能验证密码登录，短信表单必须由宿主接入真实 `SendService`。不要把 Mock 复制到生产装配，也不要声称它验证了真实短信。

## 接入顺序与最小示例

先安装两个 `.tgz`，再由宿主准备 PostgreSQL/Redis/真实 `SendService`，生成并审核 SQL、执行宿主迁移、准备用户凭据。随后建立服务端装配模块与 Route Handler，最后增加登录/改密页面及 Next 外置资源配置。完整宿主装配和凭据写入代码见 `README.md`；包内 `examples/next` 可直接复制为本地参考项目。

下面是可独立类型检查的路由工厂，例如放在宿主 `lib/auth-routes.ts`。宿主用已准备的可信配置调用一次，返回的 GET/POST 在 `app/api/auth-kit/[...path]/route.ts` 导出，并在该 Route 文件声明 `export const runtime = "nodejs"`。只有这两个受保护入口对外暴露。

```ts
import { createAuthKit, type AuthKitOptions } from "auth-kit/server";

export function createAuthRoutes(options: AuthKitOptions) {
  const kit = createAuthKit(options);
  return { GET: kit.handler, POST: kit.handler };
}
```

宿主 `app/page.tsx` 的完整最小登录页面：

```tsx
"use client";
import { AuthForms } from "auth-kit/react";

export default function LoginPage() {
  return <main><AuthForms /></main>;
}
```

改密页面使用同一组件的 `initialView="change-password"`；服务端会检查会话和当前密码。`next.config.mjs` 合并如下配置：

```js
export default {
  serverExternalPackages: ["sms-kit", "svg-captcha", "argon2"],
};
```

## 数据准备规则

宿主首次插入一个 credential 用户时，必须在同一宿主事务中创建：

- `user.id`: 宿主生成的唯一 ID；
- `user.name`: 展示名；
- `user.email`: 唯一合成值 `` `${id}@auth.invalid` ``，仅作 schema 兼容字段；
- `user.phoneNumber`: `normalizeMainlandPhone()` 返回的 E.164 值；
- `user.phoneNumberVerified: true`；
- `user.enabled: true`；
- `account.providerId: "credential"`；
- `account.accountId === user.id`；
- `account.userId === user.id`；
- `account.password`: 新密码使用 `hashPassword()` 的结果。

受信任迁移可把已有 `$argon2id$...` 编码字符串按原值写入 `account.password`，不要重新散列。标准 Argon2id 验证先运行；`verifyLegacyPassword` 只是在标准验证失败后的旧 pepper/预处理后备，不替换标准校验。所有新密码始终通过 `hashPassword()` 生成标准 Argon2id。

包没有账号维护 API。生成代码时把首次数据准备放在宿主受信任的离线或后台流程中。

## HTTP 生成契约

默认路径如下：

| 方法 | 路径 | JSON 输入 | 成功类型 |
| --- | --- | --- | --- |
| POST | `/captcha` | `{ purpose }` | `Captcha` |
| POST | `/sms/send` | `SendSmsInput` | `SendSmsResult` |
| POST | `/sign-in/password` | `PasswordLoginInput` | `AuthSuccess` |
| POST | `/sign-in/sms` | `SmsLoginInput` | `AuthSuccess` |
| POST | `/password/reset` | `ResetPasswordInput` | `AuthSuccess` |
| POST | `/password/change` | `ChangePasswordInput` | `AuthSuccess` |
| POST | `/sign-out` | `{}` | `AuthSuccess` |
| GET | `/session` | 无 | `AuthSession` |

浏览器请求必须同源并携带 Cookie。优先使用 `createAuthClient()`，它已设置 `credentials: "same-origin"`。POST 为 JSON 且请求体不超过 8192 字节。

`CaptchaPurpose` 是 `password-login | sms-login | password-reset`；`SmsPurpose` 只有 `sms-login | password-reset`。图形验证码为四位、120 秒、一次性且绑定 challenge/app/用途；短信验证码为六位、300 秒、最多三次尝试。

错误体是 `AuthFailure`：`{ error: { code, message }, retryAt?, serverTime }`。稳定错误码只有：

- `INVALID_INPUT`
- `INVALID_CREDENTIALS`
- `CAPTCHA_INVALID`
- `OTP_INVALID`
- `RATE_LIMITED`
- `UNAUTHENTICATED`
- `FORBIDDEN`
- `UNAVAILABLE`
- `NOT_FOUND`

HTTP 状态：`INVALID_INPUT/CAPTCHA_INVALID/OTP_INVALID` 为 400，`INVALID_CREDENTIALS/UNAUTHENTICATED` 为 401，`FORBIDDEN` 为 403，`NOT_FOUND` 为 404，`RATE_LIMITED` 为 429，`UNAVAILABLE` 为 503。

不要根据错误文案分支，使用 `AuthClientError.code`。所有公开时间戳是 Unix 毫秒，只有 `AuthSession.expiresAt` 是 ISO 字符串。

## 短信与验证码安全语义

- `/sms/send` 的 `{ status: true }` 只表示请求按统一策略处理，不表示供应商已受理或手机已收到。
- 未知/停用账号、供应商拒绝与超时使用相同公开响应，避免账号枚举。
- `retryAt` 来自 auth-kit 共享手机号配额，不是运营商保证。短信登录与密码重置共用同一手机号窗口：最短 60 秒，滚动 300 秒最多 3 次。
- 成功或失败的发送尝试在 `sms-kit` 返回并完成安全收尾后开始 60 秒冷却；若进程中途终止，pending fence 最长保留 360 秒（原生 OTP 300 秒加 60 秒安全余量），且不会自动重发。
- `sms-kit` 自身的模板可用性、熔断、预算、手机号窗口和投递策略继续生效；不要绕过 `SendService` 直接调用供应商。
- 供应商明确受理后才会在 Redis 写入 OTP 受理证明。证明不保存验证码，TTL 与原生 OTP 到期时间相同。验证必须同时满足原生 OTP 记录与证明；未记录受理成功的崩溃、发送失败、清理失败或 Redis 故障均失败关闭。
- 重新发送会使旧 OTP 与旧证明失效；不要在客户端缓存或重放图形验证码、短信验证码。

## 密码和会话语义

- 新密码为 8–128 字符，至少一个英文字母和一个数字；旧密码登录不套用新密码强度规则。
- 密码写入或首次 credential password 创建与全部服务端会话撤销原子提交。
- 登录态改密验证当前密码，撤销全部会话，并在当前响应中返回新会话 Cookie。
- 重置密码撤销全部会话且不建立新登录态；成功后回到密码登录。
- 退出撤销当前服务端会话。
- Session token 在客户端仅通过 HttpOnly Cookie 保存，不能返回到前端 JSON 或写入浏览器存储。

## React 页面生成规则

使用 `AuthForms` 时保留下列行为：

- 默认 `initialView="login"` 是密码登录；允许切换短信登录、返回密码登录和进入找回密码；登录后的改密页使用 `initialView="change-password"`。
- 挂载和用途变化时获取新 captcha；认证或发送失败后刷新；发送成功后也刷新已消费的 captcha。
- SVG 字符串编码成 `img` data URL，不用 `dangerouslySetInnerHTML`。
- 短信提交只发送 `{ phoneNumber, code }`；图形验证码只用于申请短信或密码登录。
- 用 `Date.now() + Math.max(0, retryAt - serverTime)` 计算本地截止时间，初始文案为 `已发送(60)`；同一规范手机号在短信登录和密码重置间共享倒计时。
- 保留字段标签、autocomplete、数字输入提示、`aria-live` 错误/状态、键盘焦点、忙碌禁用和重复提交保护。
- 不把手机号、密码、验证码放进 URL、localStorage、sessionStorage、日志或分析事件。
- 可传 `className` 并覆盖 `--auth-kit-*` 变量；不要依赖额外 UI 库。

`AuthForms` 属性：`client?: AuthClient`（默认根据路径与 fetch 创建）、`basePath?: string`（默认 `/api/auth-kit`）、`fetch?: typeof fetch`（默认全局 fetch）、`initialView?: AuthFormView`（默认 `login`，另有 `reset-password/change-password`）、`className?: string`、`onSuccess?: (action: AuthFormSuccess) => void`。`onSuccess` 的动作联合是 `sign-in | password-reset | password-change`。

### 可直接交给页面生成模型的 Prompt

```text
请为 Next.js 16.3.5 App Router 生成两个 TypeScript 页面，只使用 React 19.3.0 和 auth-kit 的公开入口。登录页从 auth-kit/react 导入 AuthForms 并使用默认视图；账户改密页渲染 <AuthForms initialView="change-password" />。页面必须是响应式的，保留 AuthForms 内置标签、键盘焦点、aria-live、忙碌状态和错误状态。不要复制认证请求逻辑，不要导入 auth-kit/server、auth-kit/schema、Better Auth 或 sms-kit 服务端入口，不要把手机号、密码、图形验证码、短信验证码写入 URL、localStorage、sessionStorage、日志或分析事件。宿主只用 className 与 --auth-kit-* CSS 变量调整外观。登录成功后的导航通过 onSuccess 在 Client Component 中处理，不自行保存 session token。
```

## 公共 API 检查清单

- 根类型：`CaptchaPurpose`、`SmsPurpose`、`AuthErrorCode`、`AuthFailure`、`Captcha`、`CaptchaAnswer`、`SendSmsInput`、`SendSmsResult`、`PasswordLoginInput`、`SmsLoginInput`、`ResetPasswordInput`、`ChangePasswordInput`、`AuthSession`、`AuthSuccess`。
- React：`createAuthClient`、`AuthClientError`、`AuthClient`、`AuthClientOptions`、`AuthForms`、`AuthFormSuccess`、`AuthFormView`、`AuthFormsProps`。
- Server：`createAuthKit`、`AuthKit`、`AuthKitOptions`、`RedisConnection`、`hashPassword`、`verifyPassword`、`validatePassword`、`AuthKitError`。
- Schema：`createAuthSchema`、`authSchemaSql`、`AuthSchema`。

生成后运行：

```sh
npm run build -w auth-kit
npm run typecheck -w auth-kit
npm test -w auth-kit
npm run test:pack -w auth-kit
```

测试环境需要 Docker PostgreSQL 18 和本机 `redis-server` 7。打包冒烟流程使用真实 `sms-kit` 服务、加密与迁移资产，仅供应商网络边界是 Mock；不要将测试结果描述为真实供应商验证。

打包冒烟同时覆盖真实 `SendService` 的登录与重置模板发送：供应商 Mock 捕获由 Better Auth 生成的六位验证码，再通过公开认证入口核验。短信登录检查错误码、用途隔离、并发仅一次成功、消费后复用失败、会话建立及退出撤销；短信重置检查改密与旧会话失效。测试手机号仅用于 Mock，不发送真实短信。
