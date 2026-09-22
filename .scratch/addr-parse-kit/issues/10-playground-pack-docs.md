# 10 — Next.js 示例、verify-pack 与文档

Status: done

仓库内 playground 示例（粘贴→解析→候选/警告→手工修正→模式切换→重组预览→确认交宿主；默认只填空项、歧义不预选、换区域清下级）。`scripts/verify-pack.mjs`：tgz→仓库外干净宿主→类型/入口/快照注入/断网运行/无 area-kit tsc 通过。文档：README.md、DATABASE.md（PG Drizzle 示例）、AI-USAGE.md（真实导出+复用提示词+实测容量+未验证清单）、CONTEXT.md+CONTEXT-MAP 登记、PACKAGES.md 更新。

## Comments

- playground：`examples/next/`（无 `package.json`，随 tgz 分发给宿主复制）。粘贴 → 解析 → 候选/警告 → 手工修正 → 模式切换 → 重组预览 → 确认交宿主；
  三条规则落地并可证：默认只填空项（非空字段需勾选“确认覆盖已有非空字段”）、歧义不预选（候选编号列表 + 无默认选中）、换区域清下级（`applyRegion` 只清空更深层级，同级分组与行政槽位互斥）。
  行为规则的单测证据：`test/example-edit.test.ts`（11 项）。浏览器点击未验证，见 AI-USAGE 的未验证清单。
- `scripts/verify-pack.mjs`：`npm pack` → 仓库外干净宿主（不安装 area-kit）→ tgz 清单/私有性、双入口与越界导入、
  文档示例编译、宿主 `tsc`、注入快照的解析断言、`next build` 负例、`next start` 端到端 HTTP（401/解析/跨区域/陈旧名称/伪造版本/超长/限流 429）、
  初始化后断网守卫下重复同样检查、`export-snapshot` 由宿主 Provider 驱动。通过后会回收宿主工作区（失败时保留排查）。
- 文档：`README.md`（5 段可编译示例）、`DATABASE.md`（`recipient_address` 列/类型/可空/索引/编码 + Drizzle 示例，手机号不唯一、`withStreet` 存储、`withoutStreet` 视图、名称快照不回写、解析建议与确认分离）、
  `AI-USAGE.md`（真实导出 + 复用提示词原文 + 实测容量 + 未验证清单）、`examples/next/README.md`、`CONTEXT.md`，并登记 `CONTEXT-MAP.md` 与 `PACKAGES.md`。
- 回归（2026-09-19，本机 Node v22.22.2 / linux-x64）：`npm run typecheck`（主 + examples 两套配置）0 error；`npm run build` 通过；
  `npm test` 77/77；`npm run test:integration` 9/9（真实 area-kit + PostgreSQL）；`node scripts/verify-pack.mjs` 14 步全绿（186 s），
  tgz SHA-256 `b35796bf6e9a6b50555a548e52871182568cd247846a9a548f23afc8c2240525`，证据在 `packages/addr-parse-kit/artifacts/pack-verification.json`。
- 未做（按约束）：不提交、不推送、不发布、不执行生产迁移；宿主侧接入事项见交付说明。
- 2026-09-21 补第三方许可声明后的复跑（详见 issue 01）：同一套断言 14 步全绿（63 s），tgz 内容变化后 SHA-256 为
  `7539f6cbdcbcb9a09f04c7059f1c14f628bdcb5f211fffa89248e0f49716a72d`；断网日志仍为 0 字节，工作区已回收。
  文档定稿后再跑：14 步全绿（45 s）→ 措辞与集成统计微调后又跑一次（57 s，14 步全绿）。
  当前字节集的 tgz SHA-256 为 `6abbc9647363a82957ad60b25dfc592f23d6d0459a6ff8de1e3a043a71383de7`，
  在此之前记录的 sha（含 `9c3eca47…`）均已被后续文档改动取代；同一字节集下 `npm run typecheck` 两套配置 0 error、`npm test` 77/77、
  `npm run test:integration` 9/9（`coldStartMs=327`）。每次跑都需 `TMPDIR` 指向 `/home/meteor/tmp`（先 `mkdir -p`，脚本不会自建）：
  默认 `os.tmpdir()` 是 2 GiB 的 `/run/user/1000` tmpfs，装 next/react 会 `ENOSPC`。
- 2026-09-21 补做浏览器点击验证（原“未验证”项）：仓库外干净宿主装 tgz → 复制 `examples/next` → `next build` + `next start`（127.0.0.1:3317）→
  `playwright-core` 驱动系统 Chrome（无头）跑 17 项断言，全绿：页面渲染、歧义样本 3 条候选且不预选（表单区不出现）、
  默认只填空项（电话保持 `13600007777` 且冲突清单可见）、勾选“确认覆盖已有非空字段”后重新填充才写入 `13200008888`、
  标准样本四级 `44/4403/440305/440305007` 且明细含“18 号”、换省为 11 后市/区县/街道代码全空、逐级重选可完整复原四级代码、
  切到不输出街道出现“已并入详细地址，未丢弃”且去空白后与切回后的预览逐字一致（并回只插入一个分隔空格，见 `src/transform.ts` 的 `${text} ${original}`）、
  路径校验通过、未勾选“我已核对”时确认按钮 disabled、确认后返回 `id` 且 `parserVersion` 由服务端补为 `0.0.0`、`manualEdits=true`、
  URL 里没有收件信息、直辖市样本分组节点“市辖区”落在市级槽位（`11/1101/110105/110105001`）且分机=802、掩码号码行原样展示 `138****6721`、
  完全未匹配样本给出 `unmatched` 且不自动填表。脚本存档为 `../playground-browser-check.mjs`（一次性工具，不进包、不进 tgz）。
  同步更新 README / examples/next/README / AI-USAGE 的验收与未验证表述。
