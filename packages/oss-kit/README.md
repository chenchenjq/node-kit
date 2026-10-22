# oss-kit

私有、可复用的阿里云 OSS 服务端文件基础包。多个存储配置由稳定用途策略 `code` 选择；提供上传、短期访问链接、流式读取、单文件删除，以及最小 React/Next.js 参考页面。目录只是 Object Key 前缀，无须创建空文件夹。

## 能力与边界

- 首版仅阿里云 OSS，默认服务端中转。支持 Buffer/Readable 上传，先有界缓冲、验证实际字节和内容，再一次 PutObject。没有浏览器直传、分片、断点续传或迁移。
- 默认策略大小 10 MiB，缓冲硬上限 32 MiB，可用 `maxBufferedBytes` 下调。每个并发上传会占用文件数据及缓冲复制所需内存；宿主应限制并发，并在反向代理/部署平台设置不高于可承受值的请求大小和执行时间。Next.js 示例使用 Node runtime、原始请求流，不使用无界 multipart 解析。平台限制可能比包更小。
- 不包含认证系统、RBAC、业务租户体系、云盘、图片处理、审核或云资源创建。宿主必须提供认证、授权、文件归属检查、CSRF/Origin 检查、限流及业务持久化。
- 默认私有。私有上传发送对象 ACL `private`，但生成签名 URL **不能证明云端禁止匿名访问**；管理员还须确认 Bucket ACL/Policy、对象 ACL、CDN 等没有匿名授权，并对真实对象验证匿名访问被拒绝。包不修改 Bucket ACL/Policy。
- 公共访问须管理员明确选择 `public`，且 Bucket 权限/已绑定域名允许访问；不会替管理员开通公开权限。已使用配置的访问模式不能原地切换。更换模式或 Bucket/Region 应新增配置，旧配置保留。
- 随机键和 `x-oss-forbid-overwrite: true` 避免覆盖；[已开启或暂停版本控制的 Bucket 中该请求头无效](https://help.aliyun.com/zh/oss/developer-reference/putobject)。单文件删除只调用当前对象 DeleteObject，不清理历史版本，版本存储/费用由宿主管理。
- 支持 jpg/jpeg/png/gif/webp/pdf/txt/json。二进制检查可识别内容特征，文本必须为 UTF-8，JSON 还须可解析；拒绝明显 HTML/SVG/主动标签及控制字节。此检查不是完整文档解析或内容审核，不保证 PDF/JSON 没有业务风险。上传设置附件下载，宿主流式响应也应设置 `nosniff` 和附件下载。

## 支持版本及入口

Node.js >=20.19（当前实测 22.22.1），ESM。锁定 `ali-oss 6.23.0`（SDK 声明 Node >=8）、`file-type 21.3.0`（Node >=20），使用 HTTPS、SDK 公开 V4 签名 API。遵循[官方 SDK 初始化说明](https://help.aliyun.com/zh/oss/developer-reference/nodejs-sdk/)，不自行实现签名。

入口：根入口仅类型；`oss-kit/server` 为服务端 API；`oss-kit/rules` 为浏览器安全命名预览/错误工具；`oss-kit/react` 为 React 18/19 回调式参考表单。服务端导出具有 browser 禁用条件，SDK 和密钥不得导入客户端。参考宿主版本：Next.js 16.3.5、React 19.3.0、TypeScript 7.0.2、Drizzle 0.45.2、PostgreSQL 18；不依赖 auth-kit/sms-kit。

## .tgz 安装

在仓库中的包目录执行：

```bash
cd packages/oss-kit
npm ci --workspaces=false
npm run typecheck
npm test
npm run build
mkdir -p artifacts
npm pack --pack-destination artifacts
```

在另一个项目中安装真实文件，无须 workspace 链接：

```bash
npm install /absolute/path/oss-kit-0.0.0.tgz
# 需要参考 UI 时，再安装宿主自己的 React/Next.js；使用示例适配器时安装 drizzle-orm 和 pg。
```

`private: true` 阻止 npm registry 发布。本包只交付 tarball，没有执行发布。

## 数据库与密钥准备

1. 实现根入口 `OssStore`：所有视图限定到一个宿主配置作用域；`transaction` 必须跨进程串行化同作用域全部写入，并提供回滚。不能仅使用单进程互斥锁。一个作用域最多一个启用默认项。
2. 示例 [schema.ts](examples/next/lib/schema.ts) 用 `createOssTables()` 生成宿主自己的表实例；[store.ts](examples/next/lib/store.ts) 接受数据库和表实例，使用 PostgreSQL 事务 advisory lock＋部分唯一索引，并先清除旧默认再设新默认。[migration.sql](examples/next/migration.sql) 只供宿主评审、纳入自己的迁移系统；不自动执行。修改表名前缀时使用宿主迁移工具根据 schema 生成相应 SQL。
3. 传入 `CredentialProtector` 复用宿主安全加解密/凭据读取能力，或使用 `createAesGcmCredentialProtector`。缺失安全实现会报 `CREDENTIAL_SECURITY_REQUIRED`。数据库只保存 envelope；列表/错误不含明文或 envelope。不要记录含凭据的管理请求。
4. AES 密钥由服务端环境提供，必须为 32 随机字节的标准 Base64；例如用 `node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64"))'` 生成并存入服务器密钥系统。不可提交到仓库、NEXT_PUBLIC_* 或客户端。密钥轮换应由宿主支持旧 envelope 解密并重新加密，不能直接丢弃旧密钥。
5. 编辑空密钥字段保留旧值；`CredentialUpdate.clearStsToken: true` 明确移除旧 STS Token。没有客户端缓存，每次操作重新读取安全凭据。STS 续期由宿主负责；短期链接也可能因凭据提前失效。

## 最小 OSS 权限

使用 RAM 身份或宿主提供的 STS 凭据，仅授权指定 Bucket 的应用前缀和独立测试前缀：`oss:PutObject`、`oss:GetObject`、`oss:DeleteObject`。不要求列举账号所有 Bucket，不调用 ACL/Policy 管理 API。按云端现有策略检查对象 ACL 请求头的授权，避免直接授予账号级 `AliyunOSSFullAccess`。

参考 RAM Resource：`acs:oss:*:*:<bucket>/<application-prefix>/*` 和 `acs:oss:*:*:<bucket>/<approved-test-prefix>/*`。实际 Bucket、应用前缀和测试前缀需管理员替换并限定；不是可直接使用的通用授权策略。

## 配置与业务接入

1. 创建服务端 kit，传入作用域 store、安全凭据和必需的 `authorize(context, request)`。没有授权回调不能初始化；回调异常或非 true 结果视为拒绝。
2. 管理员新增存储配置（名称、`oss-<region>`、Bucket、凭据）。Endpoint 默认按 Region 推导，只接受匹配的标准公网/内网 HTTPS OSS 地址；普通上传没有 Endpoint/Bucket/凭据参数。配置 ID 和 Bucket/Region 永不修改。
3. 将连接测试前缀加入服务端 `testPrefixes`，再由管理员指定其中一个前缀。默认 `[]` 禁用测试。测试上传随机小对象、读取校验内容、删除，分别返回状态；PUT 失败也尝试清理本次对象，清理失败返回精确 Key。可保存前测试填写内容，不列举 Bucket 或修改权限。停用配置也不能运行测试。
4. 管理员显式设默认项，再创建用途策略（例如 `attachments`，**需宿主创建**）。绑定存储时只用该记录；不绑定时仅新上传解析当前默认。缺失/停用均明确失败，无自动 fallback。
5. 服务端调用 `listStrategies/getStrategy` 查询宿主授权策略，前端提交真实 code 和文件。服务端生成 `应用前缀/策略前缀/[日期]/随机文件名.ext`，保留原文件名、实际字节和 MIME。
6. 保存完整 `FileReference`，包括实际 `storageConfigId` 和 `objectKey`。后续从可信业务表取得引用、检查归属，再生成链接、读取或删除；不能接受客户端任意引用。默认/策略更改不重算旧文件路径。停用配置会阻止其全部文件操作；重新启用可恢复，失败不会切换配置。停用默认会清除默认标记，重新启用不会自动恢复默认。

完整类型化 API 示例、参数默认值与错误码见 [AI-USAGE.md](AI-USAGE.md)。

## React/Next.js 示例

复制安装包内 `examples/next/` 到宿主的对应目录。三个组件通过回调复用已有宿主路由/UI，不内置认证或复杂组件库。参考表单选择原生 select，接受操作系统管理弹层；宿主可替换为自己的控件。Next 配置仅 externalize ali-oss，不能将整个 oss-kit externalize，否则 React 参考组件的 SSR 可能使用错误的 React 实例。参考路径：

- `lib/schema.ts`：宿主调用表工厂；`lib/store.ts`：注入数据库和作用域。
- `lib/files.ts`：示例业务文件表适配器，可换成宿主现有附件表。
- `lib/host.ts`：`createOssHost` 注入数据库、表、安全凭据、文件仓储、认证和请求保护，再在宿主 server bootstrap/instrumentation 调用 `installOssHost`。没有默认数据库连接或假认证。
- `app/api/oss-kit/[...path]/route.ts`：管理员配置/策略接口、业务上传，以及按业务 fileId 访问/读取/删除；所有路由先认证和请求保护，再执行操作。
- `app/page.tsx`：配置列表/编辑/测试/默认切换、策略编辑/预览、上传与访问。管理员页面须放在宿主受保护的路由；服务端仍逐次鉴权。

示例配置完数据库及宿主 bootstrap 后，用宿主的 `next dev` 启动。构建示例不会自动连接数据库，也不会创建策略。上传后业务记录保存失败可能留下 OSS 孤儿对象；示例报告 STORE_ERROR，宿主应以日志/任务协调可靠持久化和清理，勿记录签名 URL。

## 检查及实测边界

```bash
npm run typecheck
npm run build
npm test
npm run test:postgres   # Docker: 新建并销毁隔离 PostgreSQL 18 测试库，无生产连接
npm run test:pack       # 实际 tgz；仓库外 npm install、类型/文档示例、Next 构建、浏览器隔离、Mock 流程、真实 PostgreSQL
npm run test:live       # 无显式测试配置则报告“未实测”并退出；见 AI-USAGE 的严格测试护栏
```

核心/React/路由测试和真实 PostgreSQL 测试覆盖配置校验、并发默认、日期/命名/非法路径、大小/类型、加密、越权、测试步骤失败及旧引用。pack 检查保留包内 `artifacts/oss-kit-0.0.0.tgz` 和 `artifacts/verification.json`（生成物被 git 忽略），后者记录干净宿主位置和实测时间。

**真实 OSS 未实测**：没有使用真实 Bucket/凭据；上传/读取/删除网络为明确 Mock。真实 SDK 的本地 V4 签名检查不等于真实云鉴权。真实匿名拒绝、公网自定义域名绑定和权限、内网 Endpoint 可达性、云端禁止覆盖/版本控制行为和实际平台部署限制仍须宿主验证。
