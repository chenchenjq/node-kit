# AI-USAGE

这是 ai-kit 0.0.0 的真实公开接口契约。Node >=22.19、ESM、服务端直连 AI SDK 7。只处理文本，不建立认证、租户、聊天历史或模型降级。

## 入口和宿主依赖

| 入口           | 实际导出                                                                                                                                                                                                                                                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ai-kit         | 浏览器安全类型：Protocol、DictionaryItem/Port、GenerationParameters、ConnectionInput/Summary、PlanInput/Plan/Summary、TextMessage、CallInput、Usage、CompletionStatus、GenerationResult、ErrorCode/SafeError、StreamEvent、TestDraft/Result、ParameterRange、ModelCapabilities/Preset、EndpointTemplate、ProviderAdapterInfo |
| ai-kit/catalog | providerDictionaryType、providerSeeds、seedProviderDictionary、providerAdapters、modelPresets                                                                                                                                                                                                                                |
| ai-kit/server  | createAiKit、AiKitError、createAesGcmSecretProtector、createEnvironmentSecretProtector；服务端类型 AiKit、AiKitOptions、AiStore、StoreView、ConnectionRecord、SecretProtector、AuthorizationRequest、HostLimits、LogMetadata                                                                                                 |
| ai-kit/react   | AiManager、ConnectionEditor、PlanEditor、TextGenerationExample 及各 Props                                                                                                                                                                                                                                                    |

敏感 server 入口有 browser 拒绝条件与 React Server server-only 保护。根入口只是类型，不要从它初始化 SDK。createAiKit<C>(options:AiKitOptions<C>):AiKit<C> 必须提供 scope、store、dictionary、secrets、authorize(ctx,request)、rateLimit(ctx,action)、allowURL(url)。可信上下文由宿主创建。secrets.seal/open(envelope,binding) 的 binding 为 `${scope}:${connectionId}`，不能交换密文。环境变量保护器只接受明确白名单。

AiStore.read(work)/transaction(work) 向回调传 StoreView：getConnection(id)、listConnections、saveConnection、deleteConnection、getPlan(code)、listPlans、savePlan。所有读写限定 scope，read 一致快照，transaction 跨进程序列化同scope写入并回滚；数据库必须有一个启用默认的部分唯一索引。ConnectionRecord 含 credentialEnvelope，绝不可序列化给浏览器。dictionary 的 insertTypeIfAbsent/insertItemIfAbsent 必须原子幂等；listItems(type) 只读取名称、code、排序、状态。

授权请求：admin/test/dictionary；query/generate/override/system 带真实 code。每个公开操作接入宿主 rateLimit，列表摘要逐项授权。system角色消息、systemPrompt、options覆盖须额外授权；普通文本只能为 user。宿主的原子限流实现不能用前端计数或多进程不共享的 Map。

## 管理 API

下面所有方法的第一个参数 ctx 都是可信宿主上下文。

| 方法                                                    | 返回与行为                                                                       |
| ------------------------------------------------------- | -------------------------------------------------------------------------------- |
| listProviders(ctx)                                      | DictionaryItem[]；管理员读取厂商字典                                             |
| initializeDictionary(ctx)                               | void；显式幂等初始化九项，不覆盖管理员数据                                       |
| listConnections(ctx)                                    | ConnectionSummary[]；仅 hasCredential，不返回密钥/引用/envelope                  |
| saveConnection(ctx,input)                               | ConnectionSummary；创建时无id，更新必须id/revision；apiKey留空保留               |
| deleteConnection(ctx,id,revision)                       | void；被任一方案引用则 CONNECTION_IN_USE                                         |
| listPlans(ctx)                                          | Plan[]；管理员配置，包括systemPrompt与参数                                       |
| savePlan(ctx,input)                                     | Plan；id/revision更新；code创建后稳定；isDefault替换其他默认                     |
| setDefault(ctx,code或null)                              | void；null清空，目标须启用且连接启用                                             |
| listAuthorizedPlans(ctx)                                | PlanSummary[]；仅启用且获授权摘要，不含地址/系统提示/参数/密钥                   |
| testPlan(ctx,code,signal?)                              | TestResult；对已保存方案实际短文本生成；需 test、该 code 的 generate/system 授权 |
| testDraft(ctx,{connection,modelId,parameters?},signal?) | TestResult；需 test 授权；不保存表单，已有连接id/revision可留空保留凭据          |
| refreshModels(ctx,connectionId,signal?)                 | string[]；仅支持已核实/models接口；不自动更新任何配置                            |

ConnectionInput：id?/revision?、name、providerCode、protocol、baseURL、apiKey?、enabled、confirmKeyDomainChange?、clearDefault?。协议为 openai-chat/openai-responses/anthropic-messages。换域/provider前须确认密钥用途；每次保存增加 revision、testedRevision=null，不缓存跨请求客户端。停用默认连接须 clearDefault:true。新输入密钥仅在当前表单内暂留，测试或保存失败不会静默清除并恢复旧密钥；保存成功后仅清除本次提交且未被编辑的密钥；保存期间新输入的密钥仍在当前表单内暂留，不持久存草稿。

PlanInput：id?/revision?、唯一code、name、connectionId、实际modelId、enabled、isDefault、systemPrompt?、parameters?。Plan 增加必填id/revision，systemPrompt缺省null，parameters缺省{}。禁用默认方案应显式isDefault:false或先setDefault(null)。默认切换只影响后续请求。模型ID保留大小写，预设外可保存，调用需宿主resolveModelCapabilities(providerCode,modelId)返回已核实能力。

## 调用参数、返回和默认值

`generate(ctx,input):Promise<GenerationResult>`；`stream(ctx,input):AsyncIterable<StreamEvent>`。

CallInput 只含 code?、messages、systemPrompt?、options?、signal?。messages 是 `{role:'system'|'user'|'assistant',content:string}` 数组。未指定code才使用默认；显式code缺失/停用不回退。调用明确systemPrompt替换方案默认；消息内system同样需宿主额外授权并替代方案默认。空字符串systemPrompt可清空默认。禁止调用者覆盖provider/model/URL/key/header/任意JSON。

| GenerationParameters | 缺省与边界                                                                 |
| -------------------- | -------------------------------------------------------------------------- |
| temperature/topP     | 可选；留空不发送；按模型能力校验范围，不能默默忽略                         |
| maxOutputTokens      | min(1024,模型核实上限,宿主上限)，有限输出预算；含推理token而非最终文字承诺 |
| timeoutMs            | min(60000,宿主maxTimeoutMs)；请求超时明确报错，不自动重放                  |
| maxRetries           | 0；最多宿主限制与3；只重试明确拒绝的限流响应；流式永不重试                 |
| thinking             | enabled/disabled；仅核实支持的qwen/glm/deepseek模型；其他厂商拒绝          |

HostLimits 默认：maxInputCharacters=32000（含系统提示）、maxMessages=64、maxOutputTokens=4096、maxOutputCharacters=64000（正文+推理）、maxResponseBytes=2000000、maxTimeoutMs=120000、maxRetries=1。经授权覆盖也不能突破宿主和模型限制。SDK底层maxRetries固定0，不叠加重试；网络/超时/服务端错误/已输出后不自动重放。SDK报告参数不支持或钳制时转换UNSUPPORTED_PARAMETER，不把忽略当生效。

GenerationResult：text、reasoning 分离；code/providerCode/modelId、status completed或incomplete、finishReason、durationMs、requestId:string|null、usage:Usage|null。modelId优先使用厂商返回的实际模型，不改保存方案。只有正常stop且有最终正文为completed；length/过滤/无正文为incomplete。Usage包含inputTokens/outputTokens/totalTokens/reasoningTokens，各计数未知为null；整体缺失为null，绝不虚填0。Messages 的 output_tokens_details.thinking_tokens 与 Chat/Responses 的 reasoning_tokens 映射到独立 reasoningTokens；只有供应商明确返回 0 时才保留 0。total仅在原始返回或输入/输出都已知时获得。

StreamEvent：text-delta/reasoning-delta带delta；finish带result；error带安全error。预请求错误也成为error事件。完成/错误是最终状态，消费时必须检查；不要仅拼接正文。提前break会取消底层请求，但退出后的调用者无法再接收最终事件。外部AbortSignal取消或超时会取消网络流并关闭传输。短流缺失最终状态为STREAM_INTERRUPTED；部分正文可保留，不重放。

```ts
import type { AiKit } from "ai-kit/server";
export async function callConfirmedPlan<C>(
  kit: AiKit<C>,
  ctx: C,
  confirmedCode: string,
) {
  const plans = await kit.listAuthorizedPlans(ctx);
  if (!plans.some((p) => p.code === confirmedCode))
    throw new Error("方案未获授权或不存在");
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const result = kit.generate(ctx, {
    code: confirmedCode,
    messages: [{ role: "user", content: "请返回一段简短说明。" }],
    signal: controller.signal,
  });
  // result.usage === null 或各字段 null 表示 unknown，不能按 0 统计。
  return { result, cancel }; // 先返回可取消的Promise，调用方 await result。
}
```

```ts
import type { AiKit } from "ai-kit/server";
export async function consumeStream<C>(
  kit: AiKit<C>,
  ctx: C,
  code: string,
  signal: AbortSignal,
) {
  let text = "",
    terminal = false;
  for await (const event of kit.stream(ctx, {
    code,
    messages: [{ role: "user", content: "简短解释此任务。" }],
    signal,
  })) {
    if (event.type === "text-delta") text += event.delta;
    if (event.type === "reasoning-delta") {
      /* 与正文分开处理，不写日志。 */
    }
    if (event.type === "finish") {
      terminal = true;
      return event.result;
    }
    if (event.type === "error") {
      terminal = true;
      throw new Error(event.error.code);
    }
  }
  if (!terminal) throw new Error("STREAM_INTERRUPTED");
  return text;
}
```

```ts
import { AiKitError } from "ai-kit/server";
import type { AiKit } from "ai-kit/server";
export async function generateSafely<C>(
  kit: AiKit<C>,
  ctx: C,
  code: string,
  signal: AbortSignal,
) {
  try {
    return await kit.generate(ctx, {
      code,
      messages: [{ role: "user", content: "你好" }],
      signal,
    });
  } catch (error) {
    if (error instanceof AiKitError) {
      if (error.code === "CANCELLED") return null;
      if (error.code === "TIMEOUT")
        throw new Error("超时，结果可能未知；不要自动重放");
      throw new Error(error.code); // 不记录输入、回复、推理或供应商原始错误。
    }
    throw error;
  }
}
```

## 配置测试和错误

测试使用无业务数据的短消息，覆盖真实凭据、协议、URL、modelId和参数；不是ping/模型列表/HTTP200。测试先校验完整预算，再将输出限到最多128，maxRetries=0，不运行业务systemPrompt，不保存回复。已保存方案测试复用调用快照及固定可信 systemPrompt，因此需要 test、该 code 的 generate 与 system 授权；草稿测试仅需要 test 授权，宿主仍须将 test 授权限于管理员。连接和方案表单配置变化会清除旧结果；在测试完成前发生编辑时，旧异步结果不再展示为当前配置结果。

TestResult：result或null、error或null、status completed/incomplete/failed、durationMs。推理耗尽或无正文是incomplete；不自动加预算。已保存方案成功且配置revision未改变才标记连接testedRevision；字段编辑使测试状态失效。实时API可能产生费用。

AiKitError仅公开固定code/message，toJSON()安全，不保留cause、URL、key、body或请求正文。业务不要把原始SDK错误透传。错误码覆盖：

- 输入/适配：INVALID_CONFIG、INVALID_INPUT、UNSUPPORTED_PROVIDER、UNSUPPORTED_PROTOCOL、UNSUPPORTED_PARAMETER、MODEL_CAPABILITIES_REQUIRED。
- 授权/配置：FORBIDDEN、RATE_LIMITED、NOT_FOUND、DISABLED、NO_DEFAULT_PLAN、DEFAULT_REQUIRES_ACTION、CONFLICT、CONNECTION_IN_USE。
- 安全：CREDENTIAL_SECURITY_REQUIRED、CREDENTIAL_FAILURE、KEY_DOMAIN_CONFIRMATION_REQUIRED、UNSAFE_URL。
- 厂商：AUTHENTICATION（401）、QUOTA（额度机器码/402）、MODEL_PERMISSION（403/404）、PARAMETER（400/422）、PROVIDER_ERROR（5xx）。各厂商可能复用错误状态，无法核实时不编造精细原因。
- 执行：NETWORK、TIMEOUT、CANCELLED、OUTPUT_LIMIT、STREAM_INTERRUPTED、MODEL_REFRESH_UNSUPPORTED。

## 协议、预设来源与状态

核查日期全部为 **2026-09-17**。预设只包含当前官方文档出现的文本模型；不自动迁移旧管理员配置。安全上限是文档明确上限或官方示例已验证的保守预算，不保证用尽即有正文。temperature/topP仅对已核实模型启用，其他模型保守拒绝；宿主可提供核实能力，但SDK忽略仍失败。

| 厂商/code         | 预设modelId／协议／普通API SDK BaseURL                             | 核验来源                                                                                                                                                                                                              | 文档／Mock／真实API             |
| ----------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 阿里千问/qwen     | qwen-plus；Chat；https://dashscope.aliyuncs.com/compatible-mode/v1 | [模型](https://help.aliyun.com/zh/model-studio/qwen-plus)、[兼容/地域](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope)、[思考](https://help.aliyun.com/en/model-studio/deep-thinking) | 已核验／非流式+流式通过／未实测 |
| 智谱GLM/glm       | glm-5.2；Chat；https://open.bigmodel.cn/api/paas/v4                | [模型](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.2)、[API](https://docs.bigmodel.cn/cn/api/introduction)                                                                                                    | 已核验／非流式+流式通过／未实测 |
| 小米MiMo/mimo     | mimo-v2.5-pro；Chat；https://api.xiaomimimo.com/v1                 | [官方首次调用](https://mimo.mi.com/docs/zh-CN/quick-start/summary/first-api-call)                                                                                                                                     | 已核验／非流式+流式通过／未实测 |
| 月之暗面Kimi/kimi | kimi-k3；Chat；https://api.moonshot.ai/v1                          | [首次调用](https://platform.kimi.ai/docs/overview)、[参数](https://platform.kimi.ai/docs/api/models-overview)                                                                                                         | 已核验／非流式+流式通过／未实测 |
| MiniMax/minimax   | MiniMax-M3；Messages；https://api.minimax.io/anthropic/v1          | [官方兼容](https://platform.minimax.io/docs/api-reference/text-anthropic-api)                                                                                                                                         | 已核验／非流式+流式通过／未实测 |
| DeepSeek/deepseek | deepseek-flash；Chat；https://api.deepseek.com                     | [当前模型](https://api-docs.deepseek.com/quick_start/pricing/)、[思考](https://api-docs.deepseek.com/guides/thinking_mode/)                                                                                           | 已核验／非流式+流式通过／未实测 |
| OpenAI/openai     | gpt-5.4；Responses；https://api.openai.com/v1                      | [模型](https://developers.openai.com/api/docs/models/gpt-5.4)、[SDK](https://ai-sdk.dev/providers/ai-sdk-providers/openai)                                                                                            | 已核验／非流式+流式通过／未实测 |
| Anthropic/claude  | claude-sonnet-5；Messages；https://api.anthropic.com/v1            | [模型](https://platform.claude.com/docs/en/models/overview)、[SDK](https://ai-sdk.dev/providers/ai-sdk-providers/anthropic)                                                                                           | 已核验／非流式+流式通过／未实测 |
| xAI/grok          | grok-4.6；Responses；https://api.x.ai/v1                           | [模型](https://docs.x.ai/developers/models/grok-4.6)、[API](https://docs.x.ai/overview)                                                                                                                               | 已核验／非流式+流式通过／未实测 |

参数能力快照：qwen-plus temperature 为 [0,2)、topP 为 [0,1]；glm-5.2 temperature 为 [0,1]、topP 为 [0.01,1]，两者最多两位小数；MiMo 首版仅确认官方首次调用的 temperature=1、topP=0.95，其他值须宿主核实能力后开放；MiniMax-M3 temperature 为 [0,2]、topP 为 [0,1]。其他预设保守省略并拒绝显式指定这两项。[千问参数](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)、[GLM 参数](https://docs.bigmodel.cn/api-reference/模型-api/对话补全)。ModelCapabilities.temperature/topP 为 ParameterRange 或 null，ParameterRange 包含 min/max、可选 exclusiveMax/decimals。未知模型的安全预算与能力由宿主验证后注入。

OpenAI另支持Chat适配。其他厂商首版只开放表中所选核验协议；官方支持别的协议不代表本包已实现。MiMo用api-key Header并将预算映射max_completion_tokens；OpenAI 原生 Chat 的 gpt-5.4 映射 max_completion_tokens，其他兼容 Chat 映射max_tokens；Responses映射max_output_tokens；Messages映射max_tokens。qwen思考映射enable_thinking，glm/deepseek映射thinking.type；不开放未核实的思考预算。推理与最终文本可能共享输出预算，不保证最终文字额度。

千问提供新加坡dashscope-intl、美国dashscope-us普通模板；地域密钥不能混用。新业务空间域名由宿主按官方文档配置并白名单，不编造WorkspaceId。MiniMax中国普通端点模板为https://api.minimaxi.com/anthropic/v1。GLM Coding端点、MiMo Token Plan等套餐不作为普通默认模板；需要管理员明确使用匹配的端点和对应套餐凭据，换域重新确认。不自动把Python SDK基础路径原样塞入AI SDK。

手动/models刷新：OpenAI、Anthropic、Kimi、DeepSeek、xAI；其他厂商暂未开放核实接口，返回MODEL_REFRESH_UNSUPPORTED。刷新不等于生成测试，也不推断模型参数能力。默认store:false仅发送到支持的OpenAI与xAI Responses/OpenAI Chat，不向Chat兼容或Messages盲传，不等于供应商零数据保留。

## 宿主要修改的文件

1. 既有package.json：安装真实tgz，满足Node floor。
2. 既有schema/迁移：纳入examples/next/lib/schema.ts与约束；已有字典时省略fallback字典表。
3. 既有服务端bootstrap/instrumentation：按lib/host.ts注入db、可信scope、字典、安全密钥、认证授权、原子限流、白名单、限制；installAiHost。不要从浏览器创建上下文。
4. Node route：接入app/api/ai-kit/[...path]/route.ts和lib/http.ts，保留Origin/CSRF及字节限制。普通业务仅开放plans/generate/stream；管理与测试由后端授权。
5. 管理页与业务页：放入AiManager和TextGenerationExample或使用原有UI，使用lib/client.ts参考NDJSON解析、取消与最终错误处理；无需复制厂商SDK。
6. 部署秘密：配置主密钥或白名单环境引用、各厂商实际密钥。管理员显式初始化字典、创建/授权方案、必要时真实生成测试。所有生产迁移、初始化、部署仍需宿主自行执行。

## 业务开发 Prompt

> 开始业务开发前，读取ai-kit的README.md、AI-USAGE.md和宿主接入代码，通过宿主授权查询现有方案摘要并确认真实稳定方案code及用途。只使用ai-kit公开接口，不编造或自动创建方案，不初始化厂商SDK，不写死模型、地址或密钥，不自动降级。普通用户文本只能作为user消息，可信systemPrompt与参数覆盖需宿主授权。正确处理超时、取消、流内错误、断流和incomplete；没有最终状态不能宣称成功。usage缺失或计数为null表示unknown，不能填写0。不要记录完整输入、回复、推理或凭据，不把Mock成功说成真实API验证。
