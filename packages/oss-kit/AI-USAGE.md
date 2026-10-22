# oss-kit AI 接入契约

以当前公开导出和示例为准；不要假设宿主已有任何策略。首版仅阿里云 OSS，默认服务端中转，不扩展云盘/其他云厂商。配套准备步骤见 [README.md](README.md)。

## 真实公开导出

根入口 `oss-kit` **仅类型**：`DateDirectory`、`FileNaming`、`Credentials`、`CredentialUpdate`、`CredentialProtector`、`StorageInput`、`StorageSummary`、`StorageRecord`、`StrategyInput`、`Strategy`、`FileReference`、`AccessLink`、`ErrorCode`、`ErrorInfo`、`TestStep`、`ConnectionTestResult`、`AuthorizationRequest`、`StoreView`、`OssStore`、`PreviewInput`。根运行时不加载 SDK。

`oss-kit/server` 值导出：`createOssKit`、`createAesGcmCredentialProtector`、`OssKitError`、`errorInfo`。类型导出：`OssKit`、`OssKitOptions`、`UploadInput`、`StorageTestInput`、`OssTransport`、`OssTransportFactory`。后两项仅为 OSS 网络测试/观测 seam，生产通常不传 `ossTransportFactory`；不是其他云的扩展接口。

`oss-kit/rules` 值导出：`previewObjectKey`、`validatePrefix`、`validateObjectKey`、`validatedExtension`、`validateTimeZone`、`DEFAULT_TIME_ZONE`、`DEFAULT_MAX_SIZE_BYTES`、`HARD_MAX_SIZE_BYTES`、`OssKitError`、`errorInfo`。此入口可在浏览器使用，不导入 SDK。

`oss-kit/react` 值导出：`StorageManager`、`StrategyEditor`、`UploadExample`；类型导出：`StorageManagerProps`、`StorageTestInput`（浏览器安全测试请求类型）、`StrategyEditorProps`、`UploadExampleProps`。服务端入口不可进入客户端构建。

## 初始化参数和默认值

`createOssKit<Context>(options): OssKit<Context>`：

| 参数 | 含义/默认 |
| --- | --- |
| `store` | 必需；宿主作用域限定的 OssStore |
| `applicationPrefix` | 必需且应长期固定；多项目共享 Bucket 时各用不同前缀 |
| `authorize(ctx,request)` | 必需 Promise<boolean>；严格 true 才放行，异常拒绝 |
| `credentials` | 安全 seal/open；缺失时所有需要凭据的操作明确报错 |
| `timeZone` | `Asia/Shanghai`，IANA 时区 |
| `maxBufferedBytes` | 32 MiB 硬上限；可以下调，策略不能超过它 |
| `timeoutMs` | 30000；允许 1..120000，SDK 请求及输入/输出流均有限时，无自动无界重试 |
| `testPrefixes` | `[]`；测试拒绝未批准前缀，可指定批准前缀的子目录 |
| `ossTransportFactory` | 测试 seam；省略时使用真实 ali-oss 6.23.0、HTTPS/V4 |

`CredentialProtector.seal(Credentials): Promise<string>` 只返回加密 envelope 或宿主安全凭据句柄；`open(envelope): Promise<Credentials>` 从服务器安全来源读取。不得返回明文 JSON，也不得把 Secret 明文存到另一张普通业务表。包拒绝明显明文 envelope，但安全性最终依赖宿主实现。

AES helper 参数必须为服务端环境中的 32 随机字节标准 Base64，AES-256-GCM、12 字节 IV、16 字节认证标签、v1 envelope。不实现自动密钥轮换。Credentials 为 `{accessKeyId,accessKeySecret,stsToken?}`；`CredentialUpdate` 加 `clearStsToken?: boolean`，编辑留空保留旧字段，true 显式删除旧 Token，不能同时填新 Token。

`AuthorizationRequest`：管理员操作 `{action:'admin'}`；策略访问/新上传 `{action:'strategy',code}`；旧文件操作 `{action:'file',operation:'link'|'read'|'delete',reference}`。宿主授权函数必须在当前作用域验证具体策略权限、可信文件定位信息和归属。文件策略后来停用不阻止合法旧引用读取，配置停用则阻止全部操作。

## 存储、策略和持久化接口

`StorageInput`：`name,region,bucket` 必需，Region 格式 `oss-cn-hangzhou`；`endpoint?` 默认 `https://<region>.aliyuncs.com`，仅接受对应标准公网/内网 HTTPS 地址；`access?` 默认 private；`publicDomain?` 为无路径/端口/凭据/query 的公网 HTTPS origin，须管理员确认已绑定到 Bucket；`enabled?` 默认 true。

`StorageSummary`：`id,name,region,bucket,endpoint,access,publicDomain,enabled,isDefault,used,revision`。查询没有 Secret、AccessKeyId 或 envelope。`StorageRecord` 另含 `credentialEnvelope`，只供宿主持久化，禁止序列化给客户端或日志。

`StrategyInput`：`code,name,description,prefix,allowedExtensions,allowedMimeTypes` 必需；`storageConfigId?:string|null` 默认 null，仅新上传解析当前默认；`dateDirectory?` 默认 fixed，可选 fixed/year-month/year-month-day；`naming?` 默认 uuid，可选 uuid/timestamp-random/original-random；`maxSizeBytes?` 默认 min(10MiB,maxBufferedBytes)；`enabled?` 默认 true。返回 `Strategy` 为全部规范化字段加 `used`。

支持扩展名/MIME 必须配对：jpg/jpeg→image/jpeg，png→image/png，gif→image/gif，webp→image/webp，pdf→application/pdf，txt→text/plain，json→application/json。没有通配符，HTML/SVG/未知类型拒绝。MIME 必须精确匹配，不接受依靠浏览器 Content-Type 绕过的类型。

code 为 1..64 字符小写字母开头，之后允许小写字母/数字/下划线/连字符；改显示名称不改 code。保存按 code 更新，不提供删除/重命名操作。创建一个新 code 是新策略，不是旧策略重命名。

目录/applicationPrefix 长度不超过 200 字符，只允许 ASCII 字母/数字/`_`/`-`，允许单 `/` 分段；不允许头尾 `/`、空段、点段、控制字符、反斜线、百分号/越界片段。Key 不超过 1024 UTF-8 字节且限定应用前缀。原文件名不超过 200 字符，不允许路径分隔符/控制字符；保留验证后小写扩展名。original-random 将文件 stem 清洗为 ASCII、最长 80 字符，无法保留的 Unicode 名称使用 file，原名称另存 metadata 返回。所有命名都有随机部分。

`OssStore.read(work)` / `transaction(work)` 都传 `StoreView`：`getStorage(id)`→StorageRecord|null、`listStorage()`、`saveStorage(record)`；`getStrategy(code)`→Strategy|null、`listStrategies()`、`saveStrategy(strategy)`。所有读写必须限制同宿主作用域。transaction 必须跨进程串行化该作用域所有写入、失败回滚。Drizzle 示例还用部分唯一索引约束启用默认项。不要使用单进程内存 store 作为生产数据库。

## kit 方法、参数与返回

下列 ctx 必须由服务器认证得到，不来自任意请求 JSON。

| 方法 | 参数/返回 |
| --- | --- |
| `createStorage(ctx,input,credentials)` | 管理员；返回 StorageSummary；随机不可变 ID；不会自动设默认 |
| `updateStorage(ctx,id,input,credentials?)` | 管理员；完整 StorageInput 和可选 CredentialUpdate；返回 Summary；Bucket/Region 永远不可改，used 后 access 也不可改；轮换凭据无旧缓存 |
| `listStorage(ctx)` | 管理员；Summary[] |
| `setDefaultStorage(ctx,id)` | 管理员；Promise<void>；目标必须启用，串行事务内先清除其他默认再设目标 |
| `setStorageEnabled(ctx,id,enabled)` | 管理员；void；停用会清除默认，重新启用不恢复默认 |
| `testStorage(ctx,{input,credentials?,storageConfigId?,prefix})` | 管理员；可测试未保存配置或复用已存安全凭据；启用且批准前缀才执行；返回分步骤结果 |
| `saveStrategy(ctx,input)` | 管理员；Strategy；显式存储绑定必须存在，无删除/重命名 |
| `listStrategies(ctx)` | 仅授权 Strategy[]（可能含停用项）；不返回存储凭据 |
| `getStrategy(ctx,code)` | 仅该 code 授权范围；返回 Strategy，含 enabled 和上传限制 |
| `previewStrategy(ctx,input,originalName)` | 管理员；规范化策略并使用上传同一规则，返回示意 Key；随机部分固定占位，仅预览 |
| `upload(ctx,{strategyCode,originalName,mimeType,body})` | 获准策略；body 为服务器 Buffer/Readable；返回 FileReference；不接受 Bucket/目录/Key/Endpoint/凭据 |
| `getAccessLink(ctx,reference,{expiresInSeconds?}?)` | 可信引用/归属；默认 300 秒，1..900；返回 AccessLink |
| `read(ctx,reference)` | 可信引用/归属；返回 Node Readable；异步错误经净化，宿主须处理消费流错误和客户端断开 |
| `delete(ctx,reference)` | 可信引用/归属；void；只删除该定位的当前对象，不批量/不清理版本 |

`FileReference`：`storageConfigId,strategyCode,objectKey,originalName,size,mimeType` 均必需。宿主保存这些字段而不是只保存 URL。`AccessLink`：`url,expiresAt,access`；private expiresAt 为 ISO 时间，public 为 null。私有链接使用公网 OSS Endpoint，配置自定义域名时由 SDK CNAME 客户端直接签名，不替换已签名域名。链接有效性还受云端权限和 STS 提前到期影响。

`ConnectionTestResult`：`objectKey,upload,read,delete,cleanupRequired`。各步骤 `{status:'passed'|'failed'|'skipped',error?:ErrorInfo}`；read 含内容字节比较。上传失败跳过 read 但仍尝试删本次随机对象；删除失败 cleanupRequired=true，管理员需按返回 Key 检查清理。失败不删除前缀其他对象。

## 类型检查过的业务流程示例

示例函数接收真实宿主 kit；`attachments` **需宿主管理员创建并授权**。数据库保存/归属能力通过参数注入，示例不假装任意宿主已有表或策略。

```ts
import type { FileReference } from "oss-kit";
import type { OssKit } from "oss-kit/server";
type Context = { userId: string };
type FileRepository = {
  save(ctx: Context, reference: FileReference): Promise<string>;
  getOwned(ctx: Context, fileId: string): Promise<FileReference>;
};
export async function attachmentFlow(kit: OssKit<Context>, files: FileRepository, ctx: Context) {
  const strategies = await kit.listStrategies(ctx);
  const strategy = strategies.find(item => item.code === "attachments" && item.enabled);
  if (!strategy) throw new Error("请宿主管理员创建并授权 attachments 策略");
  const limits = await kit.getStrategy(ctx, strategy.code);
  if (!limits.enabled) throw new Error("策略已停用");
  const reference = await kit.upload(ctx, {
    strategyCode: strategy.code,
    originalName: "note.txt",
    mimeType: "text/plain",
    body: Buffer.from("hello", "utf8"),
  });
  const fileId = await files.save(ctx, reference);
  const trusted = await files.getOwned(ctx, fileId);
  const link = await kit.getAccessLink(ctx, trusted, { expiresInSeconds: 120 });
  // link 用于本次响应；数据库保存 reference，绝不保存临时 URL 作为永久地址。
  const stream = await kit.read(ctx, trusted);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  await kit.delete(ctx, trusted); // 真实业务只在明确要求删除时调用。
  return { fileId, expiresAt: link.expiresAt, bytesRead: Buffer.concat(chunks).length };
}
```

```ts
import { createOssKit, createAesGcmCredentialProtector } from "oss-kit/server";
import type { AuthorizationRequest, OssStore } from "oss-kit";
type Context = { userId: string };
export function initializeOss(
  store: OssStore,
  authorize: (ctx: Context, request: AuthorizationRequest) => Promise<boolean>,
) {
  return createOssKit<Context>({
    store,
    authorize,
    applicationPrefix: "my-project",
    credentials: createAesGcmCredentialProtector(process.env.OSS_KIT_ENCRYPTION_KEY ?? ""),
    testPrefixes: ["my-project-admin-tests"], // 需管理员在明确测试 Bucket 中授权。
  });
}
```

## 统一错误码

捕获 `OssKitError` 后通过 `errorInfo(error)` 得到 `{code,message,ossCode?,requestId?}`。不含 cause/raw request/SDK message/密钥/签名链接；不要额外日志打印原始 SDK 异常或管理请求。未知传给 errorInfo 的异常映射为 OSS_ERROR。

| code | 含义 |
| --- | --- |
| INVALID_CONFIG / INVALID_STRATEGY / INVALID_PATH / INVALID_FILE | 配置/策略/目录或 Key/文件名校验失败 |
| FILE_TOO_LARGE / TYPE_MISMATCH | 实际字节超限/内容扩展名 MIME 不符 |
| FORBIDDEN | 宿主授权拒绝、异常或测试前缀未经批准 |
| NOT_FOUND / NO_DEFAULT_STORAGE | 配置/策略缺失，或没有启用默认项 |
| STORAGE_DISABLED / STRATEGY_DISABLED | 明确停用；不 fallback |
| IMMUTABLE_LOCATION / IMMUTABLE_ACCESS | 修改了不可变 Bucket/Region 或已使用配置访问模式 |
| CREDENTIAL_SECURITY_REQUIRED / CREDENTIAL_FAILURE | 缺少安全处理/保护或读取失败/凭据不完整 |
| OSS_ERROR / TIMEOUT / STORE_ERROR | OSS 失败/超时/宿主持久化失败（保留安全 OSS code/requestId） |

## 宿主接入顺序和需修改文件

1. 阅读宿主现有认证、数据库 schema、密钥配置、附件/文件业务表、UI，确认使用 scope 和独立 applicationPrefix。不要调用或依赖未读取的 auth-kit 接口。
2. 将 `examples/next/lib/schema.ts` 工厂放进宿主 schema，调用 `createOssTables` 并通过宿主迁移流程安装表/约束。给 `createDrizzleOssStore(db,tables,scope)` 注入宿主已存在的 Drizzle database。不建立硬编码连接。
3. 替换 `lib/files.ts` 的示例文件仓储为真实业务文件归属/保存能力；失败上传持久化可能需要宿主协调孤儿对象清理。
4. 在宿主的 `instrumentation.ts` 或已有服务器 bootstrap 构建 `createOssHost` 并 `installOssHost`，注入 db/tables/scope/applicationPrefix/credentials/files/authenticate/protectRequest/testPrefixes。`authenticate` 返回可信用户和策略权限，`protectRequest` 执行宿主 CSRF/Origin、限流等防护；没有配置不会默认通过。
5. 接入 `app/api/oss-kit/[...path]/route.ts`，保留 Node runtime、无界 multipart 禁用、管理员授权与按 fileId 取可信引用的逻辑。普通业务不能携带任意策略外参数。
6. 将 `app/page.tsx` 三个参考块放到宿主已有管理员/业务页面；沿用已有 UI，可用 className/CSS 变量覆写样式，回调可替换为宿主 API/Server Action。业务端只展示 listStrategies 的授权策略并提交 code。
7. 管理员先配置 OSS/凭据/私有权限，测试明确测试 Bucket/前缀，设默认，再创建真实策略；不自动 seed 示例策略。

React 接口（实际定义见公开 `.d.ts`）：StorageManager 的 list/save/test/setDefault/setEnabled 回调；StrategyEditor 的 listStorage/listStrategies/save/preview；UploadExample 的 listStrategies/upload/getLink。preview 始终调用服务器 `previewStrategy`。UploadExample 的 getLink 虽接收前次返回引用，宿主回调只提交对应业务 fileId；服务器重新取可信记录，不能直接将客户端引用传给 kit。

路由示例：GET/POST `/api/oss-kit/admin/storage`，POST admin/default、enabled、test、strategies、preview；GET `/api/oss-kit/strategies`；POST `/api/oss-kit/upload` 为原始 File body＋x-oss-strategy、URL 编码 x-oss-filename、content-type；GET `/api/oss-kit/files/:id/link`、GET files/:id/read、DELETE files/:id。配置/测试 JSON 实际字节不超过 32KiB；宿主还需代理大小、并发和执行时间保护。

## 测试、打包和未验证项

在源码包目录：`npm run typecheck`、`npm run build`、`npm test`、`npm run test:postgres`、`npm run test:pack`。后两者使用 Docker 新建测试数据库并销毁，绝不读取宿主生产连接。pack 会实际生成并安装 tgz 到仓库外目录、编译这里及 README 的 TS/TSX fenced 示例、Next 生产构建、浏览器 SDK 隔离检查及最小流程，记录在 artifacts/verification.json。

真实云脚本 `npm run test:live` 只有明确设置 `OSS_KIT_LIVE_CONFIRM=test-bucket-only`、`OSS_KIT_LIVE_BUCKET`、`OSS_KIT_LIVE_REGION`、`OSS_KIT_LIVE_PREFIX`（专用测试前缀）、`OSS_KIT_LIVE_ACCESS_KEY_ID`、`OSS_KIT_LIVE_ACCESS_KEY_SECRET`、`OSS_KIT_ENCRYPTION_KEY` 才操作该 Bucket/前缀；可选 `OSS_KIT_LIVE_STS_TOKEN`。脚本不列举 Bucket，只测随机对象，校验 signed GET 和匿名拒绝并清理；输出不含凭据或链接。不要把这些变量放入公共客户端环境。

本次真实 OSS **未实测**。Mock 成功仅证明包流程。真实上传/读取/删除、匿名拒绝、实际公网自定义域名及内网 Endpoint、云端禁止覆盖/版本控制、STS 到期行为和生产部署并发/限制仍须宿主确认。V4 URL 测试使用实际 SDK 本地签名和测试密钥，不代表真实云端验证。

## 可复用业务开发提示词

> 在该宿主开发文件业务前，先读取 oss-kit 的 README.md、AI-USAGE.md 和宿主接入代码，通过宿主授权接口查询现有用途策略，确认真实稳定 code 与上传限制。示例策略必须标明“需宿主创建”，未经确认不得编造或自动创建策略。仅调用 oss-kit 的公开业务 API；不得自行初始化 ali-oss，不拼接 Bucket、目录或完整 Object Key，不从前端传地址或凭据。上传后将 storageConfigId、strategyCode、objectKey、originalName、size、mimeType 保存为可信文件引用。后续先在宿主业务表按文件 ID 取得引用并验证归属，再生成链接、读取或删除；不得信任客户端自报引用。私有签名 URL 只用于当次响应，不能作为永久数据保存。保留宿主认证、授权、请求保护和大小限制；不扩展为云盘，不把 Mock 成功描述成真实 OSS 成功。
