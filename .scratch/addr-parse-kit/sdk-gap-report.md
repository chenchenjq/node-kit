# addr-parse-kit — address-smart-parse 4.0.3 差距报告（Spike / Q21 闸门）

验收环境：Node v22.22.2，Linux x64，`address-smart-parse@4.0.3`（`PARSER_VERSION=4.0.3`，`DATA_VERSION=legacy-address-code-v1`），npm 干净安装于仓库外。
复现脚本：`/tmp/addr-spike/spike.mjs`、`spike2.mjs`、`spike3.mjs`（本报告每条结论标注用例编号）。

结论：**闸门通过** —— 所有差距均可在封装层补偿，无需 fork 或重写引擎。但有 4 项新发现的架构要求（§B），是设计树之前未覆盖的，需确认后进入编码。

---

## A. 已确认的 SDK 事实

### A1. 可依赖的能力（正面）

| 事实 | 用例 |
|---|---|
| `createParser({divisions,aliases,dataVersion})` 注入后**完全替换**内置区划，内置数据不再参与匹配 → Prompt §3「禁止静默兜底」在机制上成立 | D1、D6（真实地址在自定义源下返回 0 候选） |
| 代码原样返回：非数字、不同位数、前导零均可，父子和代码前缀**完全无关**，只按 `children` 嵌套 → area-kit 不透明字符串码可直接注入，无需转换 | F1、F5、F5b |
| 注入后修改源数组不影响索引（内部已拷贝）→ 快照语义安全 | F9 |
| 别名注入生效；每级返回 `matched / inferred / matchedText / sourceName / code / confidence` | D4、D5、A1 |
| 姓名、手机号、座机（`0371-88889999`→`037188889999`）、标签混排、多行单条输入提取正常 | A6、A7、A8 |
| 长数字不被误吞：16 位订单号、9 位房号均保留在 detail | A5、A15 |
| 重复地名不做全局去重（第二处「西安市/雁塔区」留在 detail） | A9 |
| 掩码电话不猜测：`137****5566` 保留在 detail，`phone=null` | A11 |
| 候选截断有 `CANDIDATES_TRUNCATED` 警告；重名歧义有 `AMBIGUOUS_ADDRESS`；截断不会把歧义伪装成唯一结果 | C4、C4b、E7、F6 |
| 性能：全量 4 级 createParser **236 ms**；预热后 **≈0.07 ms/条**（2000 次 138 ms）；10 012 字符长文本 25 ms；4 级全量索引净增 ≈52 MB 堆 | E3、E5 |

### A2. 缺陷与封装层补偿方案

| # | SDK 行为（实测） | 用例 | 补偿 |
|---|---|---|---|
| 1 | `detail` 是裁剪改写文本：删除所有空格/标点，不回传原文；`includeInput`/`includeNormalizedInput` 在实现中 0 引用，是**死选项** | A1、B9 | 包内永远保留 `rawInput`；`detailedAddress`/`residualText` 由本包重算（见 §B1） |
| 2 | 姓名/电话/邮编提取**无关闭开关**，唯一开关是 `extractIdCard` | A6、A13/A14 | 「关闭收件人提取」= 本包不出口 name/phone 字段 + warning 声明实体已从引擎 detail 移除、原文见 rawInput |
| 3 | **臆造下级**：输入止于区县时补出 `inferred` 乡镇（科尔沁区→科尔沁街道、南山区→南山街道、西湖区→西湖街道），confidence 0.89–0.99，**warnings 为空、scoreReasons 也无 INFERRED 痕迹** | B1、B2、B9、A13 | 判定只看 `.inferred` 布尔，不能信 warnings；默认剥离（Prompt Q9a）。实测 inferred 节点 `matchedText=null`，剥离不会丢字 |
| 4 | 无行政匹配时返回 `[]`，姓名/电话一并丢失 | C1、C2、C3、E9 | 包内最小兜底提取器（Q10） |
| 5 | **地名误提为姓名**：「云南省红河州蒙自市…」→ `name="红河州"` | B4 | 启发式拒绝：无明确标签且 name 命中源文本中的行政区名/带州·盟·旗·区县后缀 → 不出口 name + warning |
| 6 | **道路名被当乡级匹配**：「顺德路街道」→ 匹配「顺德街道」(`matchedText="顺德"`)，detail 剩破碎的「路街道白阴村…」；别名同理（「测试市」→ mt「测试」，detail 剩「市…」） | A4、D4 | 可疑判据：`matchedText` 是 `sourceName` 的真前缀，且紧随其后的原文字符属于 路/街/巷/道/坡/弄 → 该级降级为不成立，文本回并 detail |
| 7 | `parseAddressBatch` 遇任一非字符串项**整体抛错**，整批丢失 | E1 | 本包自行逐条 `try/catch` 循环，绝不使用 SDK 批量入口 |
| 8 | 非字符串输入抛 `TypeError: input must be a string`；空串/纯空白返回 `[]`（不报错） | E2、C7、C8 | 本包入口先校验类型/长度，区分「调用错误」与「未匹配」 |
| 9 | `minConfidence` 过高时静默返回 `[]`，无法区分「无匹配」与「被阈值滤掉」 | C4c | 本包**不暴露** `minConfidence`；内部固定最低值，状态分类由结构规则自行判定 |
| 10 | `maxCandidates` 0/负数被静默钳到 1，>100 钳到 100，不报错 | E7 | 本包自己校验取值（默认 5、硬上限 20），非法即报错 |
| 11 | 引擎无任何长度上限，超长输入线性变慢 | E3 | 本包强制单条 4096 字符 |
| 12 | 结果不含任何区域来源/版本字段 | E6 | `regionSource`/`regionVersion`/`parserVersion` 由本包在结果与索引缓存键上自行附加 |
| 13 | 仅省级也能成候选（「广东省」→ conf 0.29，`detail` 字段**完全缺失**而非空串） | E8 | 输出结构对 detail 做归一化；`matched` 判定按结构规则（各级 matched 状态 + 是否 inferred/歧义/截断），**不看 confidence 数值** |
| 14 | 模块加载即 eager 解析内置 1.9 MB `divisions.json`：仅 import 后堆基线 ≈47 MB，即使永远注入自定义数据也无法避免 | F9 前置测量 | 无法关闭（属引擎实现细节）；记入 README 内存基线，不改源码 |

许可证：npm 与包内 `LICENSE` 为 ISC，GitHub 仓库根无 LICENSE 文件、README 提示商用联系作者（Q7a：并行发函确认，不阻塞）。

---

## B. 新发现的架构要求（设计树未覆盖）

**B1. `detail` 不可信，必须由本包重算文本归属。**
引擎只给 `matchedText` 字符串，不给偏移量；重复地名（A9）下「字符串相减」无法唯一定位。故本包需在注入 divisions 时同时构建 `名称 → code/level` 的扫描索引，对 `rawInput` 做一次**定位扫描**得到权威文本区间，再由区间推导 `detailedAddress`（含被剥离的 inferred/可疑街道并回）与 `residualText`。这是 Prompt §4「明确文本区间映射」的字面落实，代价是本包内含一个轻量定位器（非重新实现匹配引擎，只负责定位引擎已声明命中的片段）。→ 方案选择见问题 D-1。

**B2. 引擎槽位按树深度分配，与真实行政层级无关。**
F3 实测：数据为「省 → 区县 → 乡镇」跳过市级时，引擎把区县级节点放进 `city` 槽、乡镇放进 `county` 槽。因此适配器必须携带 `code → 真实 level(1–5) / NodeKind` 映射，把引擎输出**重映射回真实层级**（`province/city/district/street`），未知即 null，绝不为凑深度造节点。→ 必做，无需决策；派生的分组节点问题见 D-2。

**B3. 逐条循环 + 单实例复用。**
不使用 SDK `parseAddressBatch`；解析器实例按 `regionSource + regionVersion` 键缓存复用，Worker 各持一份（≈52 MB/份）。

**B4. 状态分类完全自建**（见 A2#9/#13）。

---

## C. 闸门判定

Prompt §1/§2 的硬性要求中，「不静默兜底」「信息保留」「不伪造层级」「候选不假装确定」「区域来源版本固定」五项**均可通过封装补偿达成**，无需修改引擎源码。两项只能做到「可检测并提示」而非「彻底修复」，须在文档写明限制：A2#6（道路名被吞，靠后缀启发式）、A2#5（地名误提为姓名）。

未验证项（进入编码后补）：真实 area-kit 数据形状下的槽位重映射正确性、裁剪快照下的实测吞字率。
