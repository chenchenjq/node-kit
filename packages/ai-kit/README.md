# ai-kit

私有可复用文本 AI 包：管理员管理连接与方案，业务查询获准的稳定方案 code 后调用。连接保存一次受保护密钥，同一连接可有多个模型、同一模型可有多套方案。SDK 直连厂商，不配置第三方网关，不自动降级、不存聊天记录。

## 支持环境与安装

Node.js >=22.19（本地 22.22.1），ESM、TypeScript strict。参考宿主使用 Next.js 16.3.5、React 19.3.0、Drizzle 0.45.2、PostgreSQL 18。React 为可选 peer；不依赖 auth-kit。首版只支持 system/user/assistant 文本，不支持 Edge Runtime、工具、Agent、MCP、RAG、图片/音视频或持久聊天平台。

依赖精确锁定：ai 7.0.105、@ai-sdk/openai 4.0.69、@ai-sdk/anthropic 4.0.56、@ai-sdk/openai-compatible 3.0.51、undici 8.10.2。包设置 private:true，不得自动发布。

```sh
# 在 node-kit 根目录安装工作区依赖，使用根 package-lock.json。
npm ci
cd packages/ai-kit
npm run typecheck
npm run build
npm test
npm run test:postgres
npm run test:pack
# 已安装 Chromium 后，验证保留的干净宿主（浏览器 HTTP 使用 Mock）
CHROMIUM_BINARY=/absolute/path/to/chromium npm run test:browser
# 在其他项目中安装真实包；不依赖本仓库工作区链接
npm install /absolute/path/to/ai-kit-0.0.0.tgz
```

`test:pack` 生成 `artifacts/ai-kit-0.0.0.tgz`，在仓库外 `/tmp/ai-kit-consumer-*` 创建干净 Next 宿主，安装 tarball、核查文档代码与导出类型、执行九家 Mock、流式调用及生产构建，验证浏览器没有 Provider SDK、拒绝敏感入口。它保留干净宿主和 verification.json 供复核；不推送、不发布。

## 宿主准备

1. 把 `examples/next/lib/schema.ts` 纳入既有 Drizzle schema。根据宿主迁移流程安装连接/方案表、复合作用域外键及启用默认方案部分唯一索引。`migration.sql` 仅为默认表名参考，不会自动运行。数据库须保证同 scope 写事务串行化及读事务一致快照；示例使用作用域 advisory transaction lock、repeatable read。不要把内存测试 Store 用于生产。
2. 用 `createDrizzleAiStore(db,tables,scope)` 注入已存在的数据库实例；scope 必须来自可信服务端会话或固定配置，不读取浏览器 tenantId。本包不建立租户体系。
3. 注入宿主 DictionaryPort；名称 `AI模型厂商`，类型 `ai_model_provider`。没有既有字典才选 `createFallbackDictionary` 的轻量专用表，不提供通用字典后台。管理员显式运行 `initializeDictionary`；ON CONFLICT DO NOTHING 保留已有名称、排序、状态。新增字典 code 不等于拥有执行适配。
4. 注入 SecretProtector 或选择内置 AES-256-GCM（32字节 base64 宿主主密钥，独立部署密钥管理）／环境变量引用。加密 AAD 绑定 scope:connectionId；不得把主密钥与密文一同入库。环境引用须白名单，格式 `env:YOUR_ALLOWED_VARIABLE`。未提供安全能力拒绝使用，已保存值绝不回传。
5. 接入宿主现有 authenticate、authorize、请求/CSRF保护与原子共享 rateLimit。管理员管理和测试，业务查询/调用按实际 code 授权，system/参数覆盖额外授权。禁止只隐藏按钮。
6. 注入明确的 allowURL 白名单，需覆盖 BaseURL 与最终合法 SDK 路径；生产只接受 HTTPS。网络层检查全部 DNS 解析 IP、固定 IP 连接并验证 TLS hostname，禁止内网/本机/元数据/重定向及凭据跨域发送。改域或厂商需显式 confirmKeyDomainChange。不能把 allowURL 写成生产无条件 true。

```ts
import { createAiKit } from "ai-kit/server";
import type { AiKitOptions } from "ai-kit/server";
// deps 必须由宿主提供；这里不编造数据库、认证、限流或密钥读取实现。
export function createForHost<C>(deps: AiKitOptions<C>) {
  return createAiKit(deps);
}
```

## 连接和方案

先由管理员幂等初始化字典，再用界面或 `saveConnection` 创建连接。BaseURL 是**实际 AI SDK 基础路径**：OpenAI `/v1`，千问 `/compatible-mode/v1`，GLM `/api/paas/v4`，Anthropic `/v1`，MiniMax `/anthropic/v1`。不要附加 `/chat/completions`、`/responses`、`/messages`，不要重复 `/v1`。Python Anthropic SDK 示例的基础地址与 AI SDK 路径规则不同。地域、业务空间和套餐端点必须核对官方文档，不混用凭证。

API Key 编辑留空保留；保存返回 hasCredential 而非密钥或引用。改配置 revision 增加、测试状态失效；没有跨请求客户端缓存。连接被方案引用不得删除；停用关联默认连接要传 clearDefault:true。方案 code 创建后不可修改，modelId 保留大小写；预设之外可保存手填模型，调用前通过宿主 resolveModelCapabilities 提供核实能力，缺少时 MODEL_CAPABILITIES_REQUIRED。

创建方案选择 connectionId/modelId、可选 systemPrompt 与参数。默认温度与 topP 留空省略；有限默认预算最多1024、timeoutMs最多60000、maxRetries=0，均受宿主限额。默认标记在事务内替换；停用默认方案须明确 isDefault:false。`setDefault(ctx,null)` 清空。显式 code 缺失或停用报错，不回退默认、不换模型。每次请求固定配置快照。

## 业务示例

```ts
import type { AiKit } from "ai-kit/server";
export async function generateForBusiness<C>(
  kit: AiKit<C>,
  ctx: C,
  signal?: AbortSignal,
) {
  const plans = await kit.listAuthorizedPlans(ctx);
  const chosen = plans.find((p) => p.isDefault) ?? plans[0];
  if (!chosen) throw new Error("请管理员配置并授权实际方案");
  return kit.generate(ctx, {
    code: chosen.code,
    messages: [{ role: "user", content: "请用一句话说明任务目的。" }],
    ...(signal ? { signal } : {}),
  });
}
```

该示例首次从真实列表选方案；业务接入后应确认并使用适合该业务的稳定 code，不能把第一项选择实现成错误后的自动降级。公开结果包含正文、独立推理、实际 code/厂商/modelId、状态、耗时、requestId 与 usage。未知计数为 null；无正文或预算终止为 incomplete，不误报网络故障。不要记录输入/输出/推理；log 回调只接收元数据。

## 最小界面与 HTTP

`ai-kit/react` 提供 AiManager、ConnectionEditor、PlanEditor、TextGenerationExample，均由宿主注入可信回调，使用浏览器安全 DTO。连接表单测试与方案表单测试调用真实短文本，最多128 tokens，有费用提示；已保存方案可另测。使用 className 沿用宿主组件样式，示例 CSS 可替换，不开发聊天平台。

`examples/next/lib/host.ts` 展示宿主注入；bootstrap 调用 installAiHost。`lib/http.ts` 独立执行服务器授权、请求字节限制和 Origin 检查；`app/api/ai-kit/[...path]/route.ts` 为 Node runtime。POST 必须有匹配可信 origin 的 Origin header，并通过 protectRequest。浏览器不能传 signal/tenantId/model/URL/header/脚本。GET /plans 查获准摘要；POST /generate 返回 `{data}`；POST /stream 是 NDJSON StreamEvent。前端示例只传 code/user文本，支持取消、流内错误与最终状态。

表单沿用既有 oss-kit 的回调和原生控件方式；中文标签、原生 select 弹层、system-ui 正文、ui-monospace 数据，使用共享 Field/Feedback/操作锁。颜色与尺寸由参考 CSS `--ai-kit-*` 变量管理，业务宿主应映射已有 tokens。表单自然滚动，窄屏单列，无动画，焦点可见，pending锁防止重复提交，错误常驻，冲突要求重新加载；不持久保存密钥草稿或聊天内容；测试新密钥后仅在当前表单内暂留，保存成功后清除本次提交的密钥；失败或保存期间输入新密钥时仅在当前表单内暂留以便重试，确保保存的是刚测试的密钥。

共享 UI 与交互契约以本节为准（设计文档的维护等价物），不新增其他核心文档：

| Capability     | Canonical owner             | Source of truth             | Allowed variants               | Verification                         |
| -------------- | --------------------------- | --------------------------- | ------------------------------ | ------------------------------------ |
| Select/Listbox | native                      | ConnectionEditor/PlanEditor | 宿主已有控件可通过回调替换整页 | React 标签和手填测试                 |
| Form           | Field/Feedback/useOperation | src/react/shared.tsx        | className 与宿主 tokens        | 费用确认、冲突、密钥清除、StrictMode |
| CRUD           | AiManager                   | src/react/manager.tsx       | 宿主权限保护的管理页           | 版本冲突、默认并发、连接引用测试     |

## 验证与限制

九家文档核验、Mock 与真实 API 状态分别见 AI-USAGE.md。默认测试完全不访问厂商。`test:postgres` 需要 Docker，使用独立临时 PostgreSQL，绝不读取生产连接。`test:browser` 需要已安装 Chromium（可用 `CHROMIUM_BINARY` 指定），验证 `test:pack` 保留的生产构建宿主，生成桌面/窄屏截图与 browser-verification.json；浏览器 HTTP 为 Mock，不能代替后端或真实 API 验证。未提供真实凭据，九家真实 API 均未实测；不把同协议的成功当作另一家的验证。`AI_KIT_LIVE=1 AI_KIT_LIVE_PROVIDERS=qwen,... npm run test:live` 是显式可能计费的短文本验证入口，逐家读取 `AI_KIT_<CODE>_KEY`、可选 URL/MODEL；不打印密钥，结果写 artifacts/live-status.json。没有开关直接报告未实测。

短预算可能被推理耗尽；包不自动增加预算。预设是人工维护快照，不自动修改管理员方案；部分模型采用文档示例验证的保守输出上限，宿主可核实后提供能力。手动模型刷新不更新预设、方案或参数能力，失败仍可手填。OpenAI 与 xAI Responses 使用 store:false，只关闭支持的响应存储，不承诺供应商零数据保留。
