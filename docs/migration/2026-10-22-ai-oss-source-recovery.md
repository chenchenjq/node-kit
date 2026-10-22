# ai-kit / oss-kit 源码恢复与开发验收

日期：2026-10-22。目标：恢复历史原文件到 master，并在 `192.168.0.66:/www/node-kit` 验证源码开发。恢复提交：`8ad282d8a04dcfa4111044e79c883cda770d5682`。

## 恢复来源与版本证明

普通分支历史中，两包只有编译产物；四份旧工作树文件归档也不含两包 src。进一步检查 Git 未被引用的对象，找到完整目录树：

| 包 | Git tree | 原始目录内容 | 恢复 src |
| --- | --- | --- | --- |
| ai-kit | `7a44f8f39384d3ecb7c27c8caeb93820f7c12069` | 63 个文件，含脚本、测试、示例及历史产物记录 | 19 个文件 |
| oss-kit | `309dd90f862cadf1bc8beff249c7d41ec41f6747` | 46 个文件，含脚本、测试及示例 | 13 个文件 |

同时从 `/home/meteor/.codex/thread_history_1.sqlite` 读回原开发记录：oss-kit 会话 `01a0ae01-c39a-77a3-aa14-5d8678ecce97`、ai-kit 会话 `01a0ae23-aed4-7c90-ad29-2063558e368f`。历史记录分别报告 74 / 105 项测试通过；本次重新执行验证，不把旧报告当作当前测试结果。

实际恢复 **99 个文件**，包含源码、测试、示例 SQL、文档和构建／验证脚本。保留当前 package.json 的描述、OSS 许可证和 files 清单；依赖版本与历史 package.json 一致。继续使用根 package-lock.json，不恢复两个历史包级锁文件；历史 artifacts 留在恢复归档中，不作为新的验收结果。

源码没有重写或从 JavaScript 反编译。恢复后重新构建，**64 个现有 dist 文件全部逐字节一致**。原对象、恢复文件 SHA-256、差异清单、旧包备份和 Codex 摘录均已保存。两包 package.json 和根锁文件未修改。

## 为新机调整的内容

- 三个 PostgreSQL 测试脚本：固定现有迁移使用的 PostgreSQL 18.6 digest；数据目录挂载 tmpfs；通过 `import.meta.resolve("tsx/cli")` 支持 npm workspace 提升安装。
- 两份 README：将包内 `npm ci --workspaces=false` 改为根目录 `npm ci`，与本仓库统一锁文件一致。
- 其余恢复文件保持历史内容。没有修改包版本、生产业务逻辑或发布 Registry 包。

## 新主机验证

测试目录 `/www/node-kit`，Node.js 22.23.3、npm 10.9.9；复用此前验证通过的依赖安装，依赖与锁文件未变。应用测试 SHA 为 `8ad282d8a04dcfa4111044e79c883cda770d5682`；后续 README 安装说明和迁移文档修改不影响这些结果。

| 验证 | 结果 |
| --- | --- |
| 两包 build / typecheck | 均退出 0 |
| ai-kit 默认测试 | 8 文件、105 案例通过 |
| oss-kit 默认测试 | 6 文件、74 案例通过 |
| ai-kit PostgreSQL 18.6 | 12 路并发默认切换、唯一约束、跨作用域外键、字典幂等及停用后清理通过 |
| oss-kit PostgreSQL 18.6 | 跨客户端默认切换、作用域隔离、约束、事务回滚、可信文件归属及历史引用通过；OSS 网络为 Mock |
| 两包 test:pack | 均通过真实 tarball 的仓库外安装、文档代码类型检查、Next.js 生产构建、浏览器 SDK 隔离及敏感入口拒绝；OSS 包消费宿主再验真实隔离 PostgreSQL |
| ai-kit test:browser | Chromium 桌面 1280px／窄屏 390px、九家字典、费用确认、测试后保存密钥、大小写模型 ID、流式正文与未知 usage 通过；HTTP Mock |

默认测试共 **179 项**，实际由 agy / gemini-3.8-flash 调用目标机 runner 执行；已核对原始日志、SHA 和退出码。打包与浏览器流程均退出 0；一次性测试容器已回收。新 tarball、截图和验证 JSON 保存到恢复备份的 `evidence/package-artifacts/`，未以同版本覆盖 Registry。此前其余五个包的代码、依赖未变，复用已通过结果，不重复全仓回归。

## 备份与回滚

源机恢复证据目录 `/home/meteor/node-kit-source-recovery-20261022`，目标副本 `/www/backups/node-kit-source-recovery-20261022`，目录权限 0700：

- `ai-kit-recovered.tar` / `oss-kit-recovered.tar`：原 Git tree 完整导出，避免未引用对象日后被 GC。
- `ai-kit-before.tar.gz` / `oss-kit-before.tar.gz`：恢复前两包的现有文件。
- `restored-file-provenance.json`：每个恢复文件的原始与最终 SHA-256。
- `dist-rebuild-comparison.json`：64 个原编译文件重建对比。
- `codex-development-evidence.json`：原开发会话标识与相关结论摘要。
- `source-backup-SHA256SUMS`：原始恢复归档与证据的完整性清单；后续完整交付清单见 `final-SHA256SUMS`。
- `evidence/*-result.json` 与日志：本次新机实际命令、测试 SHA、退出码和输出。

迁移原备份、源机 Registry 与共享数据库保持不变。回滚源码时在独立目录恢复原 bundle／包归档，或按正常 Git 流程撤销本次恢复提交；不覆盖在线 Registry 和共享业务库，不对脏工作区执行 reset --hard。

边界：没有调用真实 OSS 或九家 AI 云端服务；本次证明源码可构建、可测试和可在新机开发，云端凭据、实际服务权限及计费调用仍需宿主单独验收。
