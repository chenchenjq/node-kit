# area-kit 首版设计

设计确认日期：2026-09-17。用户已分别确认包边界、数据模型与导入、查询与选择契约、组件与验收四部分。本 PRD 是待审核的实施依据，不代表功能已实现或数据库验收已完成。

## 1. 目标与范围

在 `packages/area-kit/` 开发可被多个项目通过真实 `.tgz` 安装的私有 Node.js 包。首版交付五级源数据准备、清洗、导入、版本管理、统一查询/搜索/路径回显/选择校验、React 级联选择与最小管理页面，以及可被 AI 正确使用的文档。

各宿主独立保存数据，同一宿主内共享区域基准；业务读取策略、认证和管理权限由宿主提供。区域代码、名称、层级和归属不作为普通字典，不接入 dict-kit，不提供源节点任意增删改。

不包含国外区域、GIS、经纬度、邮编、地址智能解析、供应商编码映射、配送范围、自动爬虫、租户覆盖继承、独立认证/RBAC、复杂版本差异可视化或跨来源自动合并。不开生产迁移或全量导入，不自动推送、发布包或修改远程仓库设置。

## 2. 仓库核查与包边界

当前仓库使用 npm workspaces，包放在 `packages/*`。sms-kit、auth-kit、oss-kit、ai-kit 均为私有 ESM 包，各有独立测试、类型检查和构建命令。已有包采用浏览器安全类型与服务端导出分离，并通过宿主注入存储和授权；Drizzle/PostgreSQL、Next.js 接入以真实源码示例展示。

没有实际业务宿主可供读取，因此不假设数据库连接、认证会话、权限方法或 UI 组件存在。`doc/前端开发规范.md` 主要约束 sms-kit，area-kit 沿用适用的服务端边界和通用交互要求，但不据此强制依赖 shadcn/ui。

选择单个模块化包，避免拆分核心包和 React 包增加版本协调成本。计划入口如下，具体类型在实施计划及实现中定稿：

| 入口 | 用途 | 运行边界 |
| --- | --- | --- |
| `area-kit` | 类型、节点摘要、分页、选择结果、错误契约 | 浏览器安全，不依赖 Node.js 或数据库运行时 |
| `area-kit/server` | `createAreaKit`、查询、校验、管理服务与错误类 | Node.js 服务端 |
| `area-kit/postgres` | Drizzle Schema、真实存储实现与迁移接入 | Node.js 服务端 |
| `area-kit/client` | 轻量 HTTP 客户端、错误转换、取消请求 | 浏览器安全 |
| `area-kit/react` | `AreaCascader`、`AreaManager` | React 客户端，保留 `use client` 边界 |

包设置 `private: true`；服务端入口拒绝进入浏览器构建。React 为可选 peer，纯服务端消费者不必安装 React；数据库依赖仅在相应入口加载。具体 Node.js、React、Next.js、TypeScript、Drizzle、PostgreSQL 支持版本以真实验收结果记入 README，不把仓库中某包的依赖版本直接当成本包已验证版本。

新建包时同步更新 `PACKAGES.md`。已存在的未提交包、目录索引与数据库设计内容不覆盖、不混入本次提交。

## 3. 数据来源与开发前核查

来源：<https://github.com/modood/Administrative-divisions-of-China>。

- 固定 commit：`c49d495b40ac73eb1a66f6eeae5f8fd10696f035`。
- README 声明数据停止更新；数据截止日期 `2023-06-30`，数据发布时间 `2023-09-11`。
- commit 时间 `2025-12-27T10:03:06Z` 仅是代码提交时间，不是区划生效日期。
- 本次读取日期 `2026-09-17`；README、许可证和五份 CSV 均读取自固定 commit。
- 仓库许可证为 WTFPL v2。保留上游原始许可证与来源声明，并区分仓库授权与源统计数据的适用说明；不宣称来源数据具有额外行政用途保证。
- 主数据是统计来源快照，包含源简码；不输出猜测的 GB/T 2260 转换码。
- `HK-MO-TW.json` 为独立名称数据，默认不并入编码主数据。编码省级数据为 31 条，不宣称覆盖港澳台或来源未包含的区域。

已完整读取五份 CSV，在内存中检查代码、空名称、相同/冲突重复、直接父节点及所有上级关联字段，结果如下：

| 文件 | 字节数 | 输入 | 有效唯一 | 相同重复 | 冲突 | 缺父 | 祖先字段不一致 | 空代码/名称 | 代码长度 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| provinces.csv | 532 | 31 | 31 | 0 | 0 | 0 | 0 | 0 | 2 |
| cities.csv | 7,580 | 342 | 342 | 0 | 0 | 0 | 0 | 0 | 4 |
| areas.csv | 85,403 | 2,978 | 2,978 | 0 | 0 | 0 | 0 | 0 | 6 |
| streets.csv | 1,630,789 | 41,352 | 41,352 | 0 | 0 | 0 | 0 | 0 | 9 |
| villages.csv | 37,730,558 | 620,573 | 620,573 | 0 | 0 | 0 | 0 | 0 | 12 |

共 665,276 个唯一节点、39,454,862 字节。此次获取、解析和上述关联核查总计约 58.6 秒，包含网络获取时间；这不是数据库导入性能结果。没有执行数据库导入、真实查询性能测试、React 测试或 `.tgz` 宿主验收。

| 文件 | 原始文件 SHA-256 |
| --- | --- |
| provinces.csv | `b17e76dab634e24e0f56021f15737c0a526dc7f0c4e39d21abeba5a8668383cd` |
| cities.csv | `a9c818e8a5120189173668b40882ce8bf59a7ec2b057c49d7a724a04bec727f2` |
| areas.csv | `169b8d99654c28cbd285e771e00688837f77af8d50c2b703592146388d2a99ab` |
| streets.csv | `831dc1c483079cee166717118e57f4b69ef6212c699dbd4bff868b59513ac14b` |
| villages.csv | `31a824829aeef7b472fced6a3f9f8321cbd9fb26661052be98904f9763ec88ce` |

实际源记录包括 `1101/1201/3101/5001` 的“市辖区”、`5002` 的“县”、`4190/4290/4690` 的“省直辖县级行政区划”、`6590` 的“自治区直辖县级行政区划”。源文件同时保留 `4419 → 441900` 东莞、`4420 → 442000` 中山、`4604 → 460400` 儋州的同名地县记录，不能压缩掉一个节点或通过补零生成它们。

`nodeKind` 采用 `region/group/statisticalUnit/unknown`。分组和统计单位分类必须有固定快照的来源证据及可审核规则/清单；不只凭名称关键字分类或重挂归属。上面列出的明确源分组用于建立首批证据清单；同名地县记录保留，无法确认具体建制性质时标记 `unknown`。

此次检查没有重复编码，但各层存在同名节点，禁止按名称合并。尚未审计全部节点的行政建制性质或现实有效性；导入检查会额外产出格式清洗、孤立节点、异常层级与覆盖报告，并复核本次计数和校验值。

## 4. 数据模型

默认表名 `area_dataset`、`area_region`。每一对表代表一个区域库，最多一个活动版本，不新增租户列或覆盖继承。不同数据库或宿主 PostgreSQL schema 可拥有独立区域库。提供可审核 Drizzle Schema 与等价 SQL，由宿主通过既有迁移流程显式执行。

### 4.1 area_dataset

| 字段 | PostgreSQL 类型 | 说明 |
| --- | --- | --- |
| id | uuid | 本宿主数据集主键，不作为跨宿主稳定版本标识 |
| version_code | text | 非空且唯一，来源标识、固定 commit 与处理规则版本共同确定 |
| source | text | 来源仓库稳定标识 |
| source_commit | text | 固定 commit |
| code_scheme | text | 非空，说明统计来源代码及源简码，非 GB/T 2260 映射 |
| data_as_of | date | 数据截止日期 |
| source_published_at | date | 来源声明的数据发布日期 |
| file_checksums | jsonb | 五份原始文件的路径、字节数与 SHA-256 |
| coverage | jsonb | 层级、地域、缺失与未覆盖说明 |
| level_counts | jsonb | 五级校验通过的有效数量，键为源 level |
| status | text | `importing/ready/failed` |
| is_active | boolean | 默认 false；为 true 时必须 status=ready |
| import_progress | jsonb | 每文件处理进度、已提交批次及恢复信息 |
| import_report | jsonb | 各级输入/有效/重复/冲突/缺父、关联与层级错误、有限错误样本及报告文件引用 |
| imported_at | timestamptz | 可空，完整校验转 ready 时记录 |
| created_at / updated_at | timestamptz | 非空，UTC |

`version_code` 稳定格式为 `<source-key>:<commit>:<rules-version>`；此来源 source-key 使用 `modood-administrative-divisions-of-china`。规范化规则改变时增加 rules-version；软件包升级本身不改变数据版本。相同 versionCode 必须匹配来源、处理规则和全部 checksum，否则拒绝继续导入。

部分唯一索引在 `is_active=true` 的常量键上实现最多一个活动数据集；CHECK 保证活动状态与导入状态一致。ready 数据集的源内容与清单冻结，失败数据集不能用于业务查询。报告只存受限摘要，大量异常明细写入独立本地报告，避免 JSONB 无限制增长。

### 4.2 area_region

| 字段 | PostgreSQL 类型 | 说明 |
| --- | --- | --- |
| id | uuid | 主键 |
| dataset_id | uuid | 非空，引用数据集 |
| code | text | 非空，保留来源字符串；不转数字、不补零、不截短 |
| source_name | text | 非空，保留原始来源名称 |
| level | smallint | 非空，CHECK 1～5；对应源文件层级，不保证全部为对应行政建制 |
| parent_id | uuid | 省级为空，其他层级非空；同版本父节点 |
| node_kind | text | `region/group/statisticalUnit/unknown` |
| display_name | text | 可空，本地展示别名；label 优先使用非空别名，否则使用 source_name |
| sort | integer | 默认 0；列表按 sort、code 稳定排序 |
| enabled | boolean | 默认 true；仅为业务启停，非行政撤销状态 |
| revision | integer | 默认 1，正整数，本地编辑的并发校验值 |
| created_at / updated_at | timestamptz | 非空，UTC |

约束：`UNIQUE(dataset_id, code)`、`UNIQUE(dataset_id, id)`；数据集 FK；`(dataset_id, parent_id)` 引用 `(dataset_id, id)`，删除 restrict；根层级与空父关系 CHECK。由导入器及存储写契约验证父层级为 level-1、全部祖先字段一致及无环，不能仅检查父 ID 存在。

索引至少包括 `(dataset_id, parent_id, sort, code)`、`(dataset_id, level, sort, code)`；编码查询使用唯一索引。名称查询有关键词与数量边界，使用 PostgreSQL 查询，不把全量节点读入内存过滤；索引调整由真实查询计划和性能验收驱动，首版不强制 pg_trgm 扩展。

### 4.3 源文件映射

五份文件共同映射 `code → code`、`name → source_name`，文件层级映射 level。省级无父；city 的 provinceCode、area 的 cityCode、street 的 areaCode、village 的 streetCode，在同一数据集查找对应 code，再解析为 parent_id。其余上级 code 字段用于核验整条来源关系，不凭代码前缀推断归属。

只做明确的格式处理、首尾空白检查、重复及关联校验；保留 source_name 原值，展示去空白可单独计算 label。不可解码、空必填字段、清洗后代码冲突、缺父、异常层级和归属冲突都是激活阻塞项；完全相同的重复可去重并记录。同名有效节点不合并，不用 AI 修复源外节点。

## 5. 数据准备、导入与激活

显式准备脚本按固定 commit 获取五份 CSV、README、LICENSE，校验原始 checksum，记录实际获取时间。全量数据保存在用户指定目录，与软件包分离。下载失败可重试，但不能替换为不同 commit 文件；初始化后的业务运行不依赖 GitHub。

脚本支持 dry-run、分批导入、恢复重试、显式激活和可选本地设置继承：

1. dry-run 不连接数据库或写业务表，检查完整五级文件并输出实际报告。
2. 正式导入先取得该数据集的 PostgreSQL session advisory lock；另一导入者不能并发写入相同数据集。显式使用独立连接持锁，连接失效时停止，不在丢锁后继续提交批次。
3. 按省、地、县、乡、村顺序导入。每批节点写入和进度更新同事务提交；相同节点幂等写入，不覆盖已有本地设置。每次恢复先验证清单和规则一致，重扫完整文件校验来源，已提交批次可安全重放。
4. 任何冲突、缺父或异常阻止激活并记录 failed。崩溃遗留 importing 可在再次取得锁后恢复；已 ready 的同版本重导入仅复核，不因失败降低状态或改写源节点。
5. 完整数据库计数与关联校验通过，设置 ready、有效数量和 imported_at。
6. 激活再取得区域库级事务锁，在同一事务中清除旧 is_active 并设置新 is_active。事务失败维持旧活动版本；部分唯一索引提供并发防线。

旧 ready 数据集永久保留至宿主另行制定保留政策，首版不提供自动删除历史版本能力。新版本默认不自动继承本地设置；显式继承时比较 code、源名称、level 和源父 code，任一变化即列为待人工确认，不自动复制。符合条件的继承也不会重写宿主已有地址。

## 6. 服务端查询与错误契约

`createAreaKit({ store, authorize })` 注入轻量 AreaStore 与可信宿主授权回调；Context 来自宿主，不能由浏览器传入角色/数据库范围。公开读操作也经过宿主策略，宿主可明确允许匿名读取。管理读与展示设置写分别授权；未接入管理授权时不能开放写操作。

计划公开操作：数据集列表/详情及活动版本、省列表、直接下级、按 level 与 ancestorCode 的列表、单个/批量编码详情、祖先链和名称路径、名称或编码搜索、选择路径校验、区域展示设置更新、有限小树查询。批量编码最多 200 条；批量结果显式列出未找到代码。

版本可用 datasetId 或稳定 versionCode 指定，二者同时提供须一致；缺省活动版本。每次请求在同一 repeatable-read 数据库快照内解析版本并读取所有节点，结果携带 datasetId 和 versionCode，不在多次子查询中重新解析活动版本。failed/importing 数据集返回 VERSION_UNAVAILABLE。

节点摘要至少包含 code、sourceName、label、level、parentCode、nodeKind、enabled、hasChildren、selectable 与 childrenState。enabled 表示自身设置；selectable 同时考虑全部祖先停用。hasChildren 表示源快照中是否存在直接下级，不因分页或停用变成 false。

childrenState 表示快照中有下级、源快照无下级或下级全部不可选。是否达到目标层级由选择结果表达；组件另外管理 unloaded/loading/loaded/error，查询失败返回错误，不伪装为空列表或真正叶子。源快照无下级仅说明来源提前终止，不断言现实中不存在下级。

列表、下级和搜索默认每页 50 条，最多 200 条，显式提供下一页信息；按 sort+code 排序。分页继续请求必须固定 datasetId；本地修改后组件使相关页失效并重新加载。首版不承诺跨多次 HTTP 请求的数据库快照隔离，管理修改可能导致列表变化，不让第一页冒充全部数据。

搜索关键词必填、最多 100 字符，参数化查询并按字面关键词处理通配字符；支持 code、名称、level、ancestorCode 与可选状态过滤。重名结果携带完整祖先路径。小树深度最多 3、节点上限 5,000；最多到县级，不加载乡村树。超限返回 QUERY_LIMIT_EXCEEDED，不默默截断为完整树。

稳定错误码至少包含 NOT_INITIALIZED、UNKNOWN_CODE、VERSION_UNAVAILABLE、TARGET_LEVEL_NOT_REACHED、PARENT_MISMATCH、NOT_SELECTABLE、FORBIDDEN、QUERY_FAILED；另需 INVALID_ARGUMENT、QUERY_LIMIT_EXCEEDED、REVISION_CONFLICT、IMPORT_CONFLICT。错误信息不暴露连接串、凭据或内部数据库原始异常。

首版不强制 Redis。若宿主使用缓存，键包含库边界、datasetId 和查询条件，设置合理失效；展示/启停修改后失效节点及受影响祖先/后代读取结果，不能永久缓存旧 selectable。

## 7. 路径选择与提交校验

targetLevel 为 1～5，默认 3，按源 level 判断，不按 UI 列数。选择结果包含 datasetId、versionCode、最终 code/level、pathCodes/pathNames、actualLevel、reachedTargetLevel、accepted 和 reason；需要分级字段时按节点 level 映射。

默认验证路径从省级开始，逐段为直接父子关系，所有节点同数据集、存在且路径完整，最终节点 level 等于 targetLevel，整条路径启用，分组不作为业务终点。路径名称由服务端生成，不信任客户端名称快照作为校验依据。

- reachedTargetLevel 表示最终节点 level 等于 targetLevel，和 accepted 独立。
- 分组为导航项。省市模式下，宿主可以用可信 SelectionPolicy 显式允许固定来源/版本的特定 group code 作为业务终点；结果标注 GROUP_ENDPOINT_EXCEPTION，保留 nodeKind=group、原 code 和源名称，不冒称行政建制。
- 提前终止默认 accepted=false；只有源快照确实无下级且宿主显式允许提前结束时，才 accepted=true，reason=EARLY_TERMINATION_ACCEPTED，reachedTargetLevel 仍为 false。加载失败、尚未加载、分页未完成或下级停用不能触发提前结束。
- 未获例外批准的分组返回 NAVIGATION_ONLY，未达到层级返回 TARGET_LEVEL_NOT_REACHED；祖先或自身停用返回 NOT_SELECTABLE。归属不匹配、版本不可用和未知代码保留各自错误。
- SelectionPolicy 来自可信宿主服务端配置，HTTP 输入不能自行放宽。前端收到同一规则用于交互，但服务端业务提交必须重新校验完整路径和当前业务版本策略。

历史读取允许旧 ready 版本与业务停用节点，并标注状态。允许读取不等于允许新提交；宿主决定新提交接受原版本还是要求活动版本。拒绝时返回明确结果，不自动按同名节点转换新版本。

## 8. React、客户端与 Next.js 接入

客户端提供可配置 baseURL/fetch 的封装，支持 AbortSignal 与统一错误。React 组件接收浏览器安全 AreaClient/回调，不导入数据库或服务端实现。真实 Next.js 示例连接客户端与宿主注入的服务端服务，使用 Node.js runtime；宿主负责认证、授权、CSRF/Origin 防护及业务提交入口。

AreaCascader 使用语义化 HTML，中文标签，可覆盖 className/样式，不绑定 UI 框架。支持受控 value、targetLevel、编辑回显、清空、disabled、加载反馈、重试、键盘操作、分页继续加载和搜索回填。所有源名称按原记录兼容地区、盟、旗、苏木等称谓，不把每列固定命名为市/区。

按父 code 懒加载，更换父项立即截断失效后代并通知宿主，取消旧请求且用请求标识忽略迟到响应。search/path 回填也受版本、请求标识和受控值约束；一次路径回填不混用活动版本。清空/父变化时不能保留旧 accepted 结果。

未提供 value 时开始新选择并固定一个活动数据集；value 有 datasetId 时按原版本回显。活动版本变化不自动修改已选值或切换其下级请求的数据集。例外分组、提前终止、停用和旧版本均有文字状态提示。

AreaManager 提供区域树/分页列表、名称/代码/级别筛选、详情与祖先路径、展示名称/排序/启停编辑，以及版本、覆盖、导入报告查看。请求全部有加载、错误、重试和空状态；保存携带 revision，冲突要求重载，成功刷新受影响结果。隐藏操作不是授权替代。不提供全国源节点编辑、Web 全量导入、复杂导入平台或认证后台。

## 9. 历史地址与跨项目传输

宿主至少保存 datasetId+最终 code；重要地址另存 pathCodes/pathNames 快照。收件人、电话和详细地址仍由宿主负责；不只保存内部行 ID 或中文名称。跨宿主传输携带 source+versionCode+code，不假设 datasetId 相同。

先按原版本查询并标注本地停用/旧版本状态。UNKNOWN_CODE 或 VERSION_UNAVAILABLE 时可回退宿主名称快照并提示不可核验；QUERY_FAILED 显示错误和重试，不能冒充记录不存在。不自动映射同名新区域，软件/数据更新不重写订单、客户或历史地址。

## 10. 验收与测试

仅运行 area-kit 声明的测试、类型检查、构建及其宿主验收；涉及共享配置后才扩大受影响检查范围。功能验收必须运行测试并记录真实结果，不以设计替代实现。

### 10.1 实际样本与行为

从固定完整快照选取普通五级路径、直辖市分组、省直辖县级、东莞/中山/儋州同名地县、特殊统计单位或分类 unknown 的对应记录、同名节点和港澳台未覆盖样本。记录每条样本的来源与分类证据；不存在的结构性异常用明确标注的合成 fixture 测试，不能假称源快照实例。

覆盖 1～5 级、两级/三级常用选择、完整路径回显、分页、搜索重名与完整上级路径、父变化清空、请求乱序、搜索回填与取消、明确提前终止策略、分组例外、祖先停用和直接接口提交校验。覆盖历史原版本不被活动切换修改、未知历史回退、查询故障不假空、键盘与受控值行为。

### 10.2 导入与数据库

用隔离 PostgreSQL 完整导入五份实际 CSV，复核共 665,276 个节点及逐级数量、唯一、同版本归属与祖先关系。记录 CPU/内存、OS、Node/PostgreSQL/Drizzle 版本、批大小、数据大小、准备/校验/导入/激活耗时和代表性查询计划/表现；本次 58.6 秒文件核查不替代该项。

故障测试包含字符串代码不损坏、相同重复、冲突/空字段/缺父/异常层级、批次前后中断恢复、同版本幂等、并发导入锁、失败不切换活动版本、并发激活唯一、跨版本父 FK 拒绝、本地设置保留、继承变化需人工确认及 revision 冲突。测试 ready 数据集重导入不能损坏原活动状态。

### 10.3 打包与干净宿主

npm pack 只包含代码、类型、必要脚本、清单、许可证说明、迁移/接入示例及四份文档；全量原始数据、构建缓存、测试数据库连接和任何密钥不进入包或浏览器构建。

仓库外的干净 Next.js 宿主安装真实 `.tgz`，不依赖工作区链接，验证公开导出、四份文档的 API 示例类型、真实数据库接入、管理及级联流程。浏览器误导入服务端入口必须构建失败；正确导入不能包含 pg/Drizzle 或全量数据。已初始化查询在禁止外部网络访问且本地测试数据库可达的环境运行，证明运行阶段不依赖 GitHub。

若未完成完整村级导入、真实数据库或干净宿主验收，最终逐项列出未验证项，不以 Mock 或样例声称全量完成。不执行发布。

## 11. 文档交付

基于真实实现与已执行测试生成 `packages/area-kit/` 下四份文档：

1. README.md：边界、实际支持版本、tgz 安装、数据准备、宿主数据库/权限接入、初始化/运行/测试/打包命令。
2. DATABASE.md：字段/约束/索引、五份 CSV 映射、代码与父关系、特殊节点、版本切换、业务保存示例、可审核 Schema/SQL 和 ER 图。
3. DATA-SOURCE.md：实际 commit、数据截止/发布/获取日期、checksum、许可证与来源说明、实际覆盖/数量、清洗报告、停止更新限制，区分抽样与全量核验。
4. AI-USAGE.md：真实导出、参数/返回/错误码/默认值、宿主要修改的文件、按级别选择、查询/搜索/校验/回显、历史处理、验证命令及已知限制。公开 API 示例通过类型检查。

AI-USAGE.md 必须包含：

> 先读取 area-kit 文档和宿主已启用的数据版本，按业务指定 targetLevel，只用公开接口查询和校验；不另装区域库、不维护第二份 JSON、不猜测区域代码、不填零转换、不将统计分组冒称为行政建制。保存数据版本、区域 code 和必要的名称路径快照；正确处理特殊层级、缺失数据、停用项和历史版本，不得静默改写已有地址。

本 PRD 同步影响 `doc/数据库设计.md` 的 area-kit 表与生命周期设计。最终回复仅汇总交付文件、实际验收结果、未验证项和宿主剩余配置。

## 12. 实施顺序与宿主责任

依赖顺序：包骨架与契约/固定来源清单 → 数据准备与完整 dry-run → Schema/存储与可恢复导入/激活 → 查询/校验/管理服务 → 客户端/React 与 Next.js 示例 → 完整数据库验收 → tgz 干净宿主及断网验收 → 四份实际使用文档。

各部分围绕同一版本化区域模型，不拆成独立包或无关子项目。具体任务、文件与验证命令由 writing-plans 在 PRD 审核通过后制定；目前不开始实现。

宿主最终必须提供数据库连接与迁移接入、可信 Context 和读写授权、HTTP 请求保护、选择例外/业务版本接受策略、历史地址字段及必要快照。area-kit 提供真实可工作的参考接入，并明确这些依赖，不假设已有宿主接口。
