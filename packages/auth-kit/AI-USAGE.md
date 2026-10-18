## 0.3.1 开发局域网地址（2026-10-12）

`developmentOrigins` 可显式配置私有 IPv4/loopback HTTP Origin，HTTP 写入和 Better Auth 内部调用均校验；生产环境拒绝该开发白名单，正式环境仍要求精确 HTTPS baseURL。不接受公网 HTTP、DNS 域名、通配符或从请求头动态生成的信任地址。SCM 开发白名单为 http://192.168.0.108:3000，规范地址为 http://127.0.0.1:3000。

## 0.3.0 邮箱兼容更新（2026-10-12）

SCM 用户最新决策采用邮箱/手机号密码登录，保留存量邮箱和 bcrypt 密码。`loginId` 现在也接受合法邮箱，trim 后转小写并直接查询认证 email；用户名 resolver 保留供既有消费者使用。认证手机号改为可空，非空时仍唯一且必须为 11 位；不得填入虚构手机号。无手机号账号支持密码登录、会话、登录态改密、管理员恢复；短信登录与短信重置仍要求已绑定的真实号码。所有已解析登录标识共享稳定 user ID 限流和事务锁。

从 0.2.0 升级现有 schema 时，维护窗口显式执行 `ALTER TABLE <auth_schema>."user" ALTER COLUMN phone_number DROP NOT NULL`，保留唯一索引及号码 CHECK。本版本不提供注册入口，也不提供邮箱发送/邮箱验证码重置。SCM 宿主须同步更新 UI、业务投影、迁移及账号写入权威。

# auth-kit 生成代码约束

以 [README](README.md)、公开类型与锁定版本为准。0.2.0 要求 sms-kit 0.0.19；旧 sendService/tenantId/verify/consumeProof 装配不适用。

1. 只接入 kit.handler，不暴露底层 Better Auth。账号由管理员创建，关闭宿主旧注册与邀请旁路；不得生成自助注册。
2. 密码登录使用 loginId（用户名/手机号）并提交图形码；用户名查唯一业务键，返回稳定认证用户 ID；目标用户仍须有手机号。
3. 认证手机号存 11 位；使用 normalizeMainlandNationalPhone。短信保护器显式 storageFormat: national，旧密文迁移单列，不误称已自动转换。
4. 短信采用 SYSTEM SystemAuthSmsService，auth 与 sms 必须同库。verifyAndConsume 使用传入的 SmsTransaction；不得另开事务、提前提交或忽略失败次数。
5. 申请短信和密码登录必须带 captchaId/captchaAnswer 与同源 Cookie。120 秒、一次消费、用途/浏览器绑定；刷新已用图形码。
6. 重置与改密都撤销全部会话并清除当前 Cookie，不自动重新登录。密码、会话、号码、验证码不进日志/URL/localStorage。
7. 迁移必须显式执行并预检冲突，不能在 createAuthKit 启动时执行。维护窗口暂停旧副本，不能混跑 E.164 与 11 位认证版本。
8. 包验证分离单元、真实 PG/Redis、打包、干净宿主安装和真实供应商。不得将 Mock 网关或导入成功写成短信发送成功。

浏览器仅使用 auth-kit/react 与根类型。服务端公开入口 auth-kit/server 和 auth-kit/schema；README 给出装配与测试命令。Next serverExternalPackages 合并 sms-kit/svg-captcha/argon2；不把整个 auth-kit 外置。

0.3.4: runtime logic is unchanged from 0.3.3; metadata declares sms-kit 0.0.19 / 0.0.20 compatibility, verified by SCM PostgreSQL password/SMS/reset tests.
