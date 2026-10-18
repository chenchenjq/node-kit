## 0.3.3 手机号绑定并发

在账号锁内重新核对手机号登录/短信请求的号码仍属于当前用户，拒绝已变更绑定的旧号码请求。宿主变更手机号时还须同事务使该用户的 SYSTEM OTP 全部失效，并撤销会话。

## 0.3.2 浏览器验证码时序

串行生成同一表单的图形验证码，防止 React StrictMode/快速切换产生并发响应，导致浏览器 Cookie 与显示的 challenge 不一致。服务器仍强制校验和原子单次消费，没有放宽验证码规则。

## 0.3.1 开发局域网地址（2026-10-12）

`developmentOrigins` 可显式配置私有 IPv4/loopback HTTP Origin，HTTP 写入和 Better Auth 内部调用均校验；生产环境拒绝该开发白名单，正式环境仍要求精确 HTTPS baseURL。不接受公网 HTTP、DNS 域名、通配符或从请求头动态生成的信任地址。SCM 开发白名单为 http://192.168.0.108:3000，规范地址为 http://127.0.0.1:3000。

## 0.3.0 邮箱兼容更新（2026-10-12）

SCM 用户最新决策采用邮箱/手机号密码登录，保留存量邮箱和 bcrypt 密码。`loginId` 现在也接受合法邮箱，trim 后转小写并直接查询认证 email；用户名 resolver 保留供既有消费者使用。认证手机号改为可空，非空时仍唯一且必须为 11 位；不得填入虚构手机号。无手机号账号支持密码登录、会话、登录态改密、管理员恢复；短信登录与短信重置仍要求已绑定的真实号码。所有已解析登录标识共享稳定 user ID 限流和事务锁。

从 0.2.0 升级现有 schema 时，维护窗口显式执行 `ALTER TABLE <auth_schema>."user" ALTER COLUMN phone_number DROP NOT NULL`，保留唯一索引及号码 CHECK。本版本不提供注册入口，也不提供邮箱发送/邮箱验证码重置。SCM 宿主须同步更新 UI、业务投影、迁移及账号写入权威。

# auth-kit

面向管理员预建账号的私有认证包。密码登录兼容邮箱/手机号及旧用户名；提供短信登录、重置密码、登录态改密、退出、会话读取与图形验证码。Better Auth 管理服务端会话；短信使用 `sms-kit` 的 `SystemAuthSmsService`。不提供自助注册、邮箱邀请或账号维护 API。

## 0.2.0 升级契约

本版本包含破坏性变更，不能覆盖发布旧版 0.1.1：

- 认证 `user.phone_number` 必须是唯一的 11 位大陆手机号。输入兼容 `+86`、`+086`、`0086`，数据库 CHECK 拒绝带前缀值。
- 密码登录和申请短信必须提交 `captchaId`、`captchaAnswer`。缺少或无效图形码由服务端拒绝。
- `sms.service` 必须实现 `issue` 和 `verifyAndConsume(input, transaction)`；不再接受仅实现 `verify/consumeProof` 的旧装配。
- 要求 `sms-kit@0.0.19`、`pg@8.23.0`、Node >=20.19，React peer 为 >=19.1 <20。版本范围不是对每个宿主框架的兼容证明，须验证宿主精确版本及锁文件。

不要发布到公共 npm。新版本是否已发布、宿主是否已安装，以发布记录和宿主锁文件为准；源码版本号本身不是发布证明。

## 装配与信任边界

```ts
import { createAuthKit, type AuthKitOptions } from 'auth-kit/server';
import { createAuthSchema } from 'auth-kit/schema';
import type { SystemAuthSmsService } from 'sms-kit/application';

export function composeAuth(
  host: Omit<AuthKitOptions, 'schema' | 'sms'>,
  systemAuthSms: SystemAuthSmsService,
) {
  return createAuthKit({
    ...host,
    schema: createAuthSchema('scm_auth'),
    sms: { service: systemAuthSms },
  });
}
```

宿主提供 `appId`、精确公开 origin `baseURL`、至少 32 字符 `secret`、`pg.Pool`、Redis 的 `eval` 接口和受信任 `resolveClientIp`。所有副本使用相同 appId/secret/数据库/Redis。生产必须 HTTPS；HTTP 仅允许 loopback。默认路径 `/api/auth-kit`；同源 POST 校验 Origin，JSON 请求最大 8192 字节。Redis 故障失败关闭。

`SystemAuthSmsService` 的 `PgSmsStore` 必须指向与 auth-kit 相同的 PostgreSQL 数据库。认证把当前事务的同一个 pg client 传给 `verifyAndConsume`；自定义实现不得另开连接或提交事务。返回 false 时认证提交失败次数，返回 true 后继续写凭据/会话；异常时整体回滚。

使用 `AesGcmPhoneNumberProtector(keyProvider, hasher, { storageFormat: 'national' })`，使短信加密原文也是 11 位。旧 sms-kit 消费者默认仍为 E.164；`unprotect()` 与网关边界仍返回 E.164。手机号 HMAC 保持统一 E.164 输入，以复用旧索引、限流和查找；Hash 不是手机号原值。历史密文不会自动改写。

宿主先审核并执行 `authSchemaSql('scm_auth')` 和 sms-kit migrator，再注入服务。`createAuthKit` 不执行迁移。连接池、Redis 超时、单例生命周期、可信代理与密钥配置由宿主管理。

Next.js 使用 Node Runtime 的 catch-all Route，只导出 `kit.handler` 的 GET/POST，不暴露底层 Better Auth handler。将 `sms-kit`、`svg-captcha`、`argon2` 合并进 `serverExternalPackages`，保留原有列表。浏览器只导入 `auth-kit/react` 或根类型。

## 管理员创建账号

宿主在受平台管理员鉴权保护的事务中准备业务用户与认证投影，保留同一稳定 ID：

- `user.phoneNumber` 使用 `normalizeMainlandNationalPhone`（`sms-kit/core`），全局唯一；无手机号用户保留 NULL，不能伪造号码。
- `user.name` 为显示名；唯一合成 `email` 可用 `${id}@auth.invalid`，不是邮箱登录。
- `phoneNumberVerified` 只能依据已完成的可信号码核验设置；管理员录入号码不等于验证其归属。
- `account.providerId = 'credential'`，`accountId` 与 `userId` 等于用户 ID；新密码使用 `hashPassword()`。
- 管理员创建、改密、停用及手机号变更须同步权威投影并撤销相关会话；不允许客户端直接写入认证表。

包没有注册接口；宿主仍须关闭其旧注册页面、旧注册 action 和邀请接受旁路。包测试的 404 不等于宿主旧接口已经退役。

## 用户名与手机号

`signInPassword({ loginId, password, captchaId, captchaAnswer })` 接受用户名或大陆手机号；旧 `phoneNumber` 标识也可用，不能同时提交二者。`resolveUsername(username): Promise<string | null>` 由宿主按唯一用户名返回已有认证用户 ID。例如 SCM 使用唯一 `users.account`，不能按显示名查询。包不创建用户。

用户名仅 trim，保留大小写，最长 100 字符，拒绝邮箱、空白及控制字符；有效手机号优先解析为手机号，管理员须避免创建歧义用户名。未配置 resolver 时只支持手机号。用户名或邮箱账号可以没有手机号。用户名与手机号共享手机号限流与数据库锁；禁用/未知/错误密码返回统一凭据错误。`isUserAllowed` 可附加宿主资格检查。

## HTTP 与图形验证码

相对默认 basePath：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/captcha` | 输入 purpose：password-login / sms-login / password-reset |
| POST | `/sms/send` | phoneNumber、purpose（sms-login / password-reset）、图形码 |
| POST | `/sign-in/password` | loginId 或 phoneNumber、password、图形码 |
| POST | `/sign-in/sms` | phoneNumber、六位 code |
| POST | `/password/reset` | phoneNumber、code、newPassword |
| POST | `/password/change` | currentPassword、newPassword；须已登录 |
| POST | `/sign-out` | 当前设备退出 |
| GET | `/session` | 会话读取 |

图形码四位、120 秒，绑定签名浏览器 challenge cookie、appId、用途。Redis Lua 原子读取并删除，正确/错误答案都会消费；错误、过期、跨用途、跨浏览器或并发重放均拒绝。客户端必须同源带 Cookie，并在消费后刷新图形码。

短信 OTP 由 SYSTEM 短信服务生成、校验和持久化。只有服务商已受理的有效挑战可验证；登录与重置用途隔离、失败次数持久化、成功仅消费一次。Redis 保存挑战 ID 缓存，PG 是最终权威；缓存存在不代表验证码仍有效。包内短信限流与 sms-kit 策略同时生效，管理页面不能把其中一层配置冒充最终有效策略。

`/sms/send` 的 status true 是统一处理响应，不等于手机收到；未知/禁用用户不发送。基础设施或供应商异常可能返回 UNAVAILABLE/RATE_LIMITED，不声称所有异常响应与未知用户完全一致。完整抗枚举策略须在宿主验收。

## 密码与事务

新密码 8–128 字符，至少含一个英文字母和数字；使用 Argon2id。`verifyLegacyPassword` 可作受控旧 hash 后备验证，不自动重写旧 hash。

重置在同一 PG 事务内验证并消费 OTP、写 credential、删除全部会话，成功后不自动登录。登录态改密校验当前密码后原子写密码并删除全部会话。响应清除当前 Cookie；其他设备服务端会话已失效。短信登录的 OTP 消费和会话建立也在同一事务，建会话失败可重试未消费 OTP。

错误体为 `{ error: { code, message }, retryAt?, serverTime }`。客户端按 code 分支；时间戳为 Unix 毫秒，session.expiresAt 为 ISO 字符串。不得将密码、图形码、OTP、手机号原文或会话 token 写日志、URL或浏览器存储。

## 显式号码迁移与回滚

`migrateAuthPhoneStorage(pool, namespace)` 从 `auth-kit/server` 导出。仅在维护窗口执行：先备份，暂停所有认证副本和账号写入，等待旧 OTP/发送窗口过期，再迁移。函数锁认证 user 表、规范化全表、在修改前拒绝冲突、原子更新并撤销受影响账号会话、补充 CHECK；重复执行返回 0。非法号码和碰撞需人工治理，不能自动合并用户。

它只迁移认证 schema，不迁移 SCM 业务表、历史短信密文或 Redis 键。宿主须另行核准这些数据的转换与旧缓存失效；新旧包不能混跑。回滚需恢复一致的数据库快照/约束与旧版包，不能只回退 JS；禁止在已产生新密码后盲目恢复旧密码快照。没有任何生产迁移随安装自动执行。

## React 与验证

`AuthForms` 提供 login、reset-password、change-password 视图；通过 onSuccess 导航。优先使用 `createAuthClient`，同源 Cookie 已启用；保留标签、键盘操作、aria-live、忙碌状态及验证码刷新。主题通过 className / CSS 变量调整。

```sh
npm test --workspace auth-kit
npm run typecheck --workspace auth-kit
npm run test:integration --workspace auth-kit
npm run build --workspace sms-kit
npm run build --workspace auth-kit
npm run test:pack --workspace auth-kit
```

集成测试启动独立 PostgreSQL 17 与 Redis 7 容器，使用真实 Better Auth / sms-kit / 加密与迁移，仅物理短信网关与图形码答案受控。覆盖存储约束、图形码重放、事务故障、用途隔离、并发消费及迁移碰撞。打包冒烟复用工作区依赖，不能替代干净宿主安装或真实阿里云验收。

0.3.4: runtime logic is unchanged from 0.3.3; metadata declares sms-kit 0.0.19 / 0.0.20 compatibility, verified by SCM PostgreSQL password/SMS/reset tests.
