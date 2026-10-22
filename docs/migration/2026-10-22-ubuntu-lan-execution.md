# node-kit 迁移执行与新机开发验收

执行日期：2026-10-22（Asia/Shanghai）。目标 `meteor@192.168.0.66:/www/node-kit`。依据 [迁移方案](./2026-10-22-ubuntu-lan.md) 执行，代码与 Verdaccio 数据已经迁移；五个有源码包的开发环境验收通过。源机继续保留用于回滚。

## 1. 已交付环境

| 项目 | 实际状态 |
| --- | --- |
| 项目 | `/www/node-kit`，master；与源机最终提交一致，最终 SHA 见两端备份目录的 `final-manifest.json` |
| 系统 | Ubuntu 24.04.4 LTS，x86_64 |
| Node / npm | 22.23.3 / 10.9.9 |
| Docker / Compose | 29.9.0 / 5.6.1，meteor 可直接运行测试容器 |
| 原生 PostgreSQL / Redis | 实测 18.6 / 8.2.10，保留现有服务与数据 |
| 隔离测试 | 一次性 PostgreSQL 18.6 / Redis 8.2.10 容器，随机端口；结束后已回收 |
| Registry | [http://192.168.0.66:4873](http://192.168.0.66:4873)，Verdaccio 5.33.0，容器 healthy，重启策略 unless-stopped |
| Registry 存储 | `/www/node-kit/deploy/registry/storage`；保留原 numeric UID/GID |
| 本机 npm 认证 | `/www/node-kit/.npmrc.local`，0600，Git 忽略；显式 `--userconfig` 使用；现有账号 chenjq 的 whoami 校验通过 |
| 浏览器 | Playwright 所需 Chromium 134.0.6998.35 及 Ubuntu 依赖已安装；实际无头浏览器打开新 Registry 并识别 auth-kit / sms-kit |

没有迁移 SCM、OMS、Velox 等宿主业务数据库，也没有复制共享 Redis 实例。盘点未发现 node-kit 独立常驻业务库；这些包通过宿主注入连接，开发测试使用隔离容器。没有创建示例性的 `node_kit_dev` 数据库或假定不存在的账号。

## 2. 数据与代码完整性

1. 已复制原准备阶段备份，目标目录 `/www/backups/node-kit-migration-20261022`，校验原 SHA256SUMS。主代码由 bundle 的 master 恢复，origin 配置为 `https://github.com/chenchenjq/node-kit.git`。本次未推送 GitHub。
2. 源 Verdaccio 短暂停止后生成一致性归档，随后恢复服务。storage 共 **2727 文件、1,885,850,751 bytes**；目标启动前逐文件 SHA-256 校验全部通过。
3. 源镜像导出并加载到目标。Docker 旧存储与 containerd 显示的 image ID 不同，但 RootFS 层、Config、架构及 OS 完全一致，证据 `image-equivalence.json`；未升级 Verdaccio。
4. 通过新机 HTTP 下载并校验 **7 个包、40 个版本**的 tarball、完整性、包名与版本。迁移收尾时两端版本集合、标签和 tarball 摘要仍与停写快照一致。
5. 标签原样保留：sms-kit latest=0.0.18、scm-verified=0.0.20；auth-kit latest=0.1.1、scm-verified=0.3.5；area-kit latest=0.0.4；其余四包 latest=0.0.0。没有发布新包或覆盖原版本。
6. 源、目标认证均返回账号 chenjq。仅在目标本地私有配置保存指向本机和 LAN Registry 的 token；SSH 私钥未复制，token 未进入 Git 或文档。
7. 目标在独立消费目录实际从新 Registry 安装 auth-kit@0.3.5、sms-kit@0.0.20，并加载 `createAuthKit` / `SystemAuthSmsService` 成功。既有 Registry 包与合并后源码不是同一产物；将来发布需新增版本。

## 3. 迁移中发现并修正的问题

均为新机干净安装或环境验证实际暴露的问题，没有修改业务逻辑：

- `067f0467`：addr-parse-kit 的 area-kit 开发依赖由旧 0.0.0 对齐已整合的 0.0.4。
- `70908ad7`：补全根 npm lock 中 sku-kit 与平台依赖；测试镜像固定为 PostgreSQL 18.6、Redis 8.2.10，适配 PostgreSQL 18 的 tmpfs 挂载父目录。
- `00a8d0c1`：Registry 容器健康检查由 localhost 改为 127.0.0.1，解决 IPv6 localhost 探测失败而 IPv4 服务正常的问题。
- `0ea32e3c`：area-kit PostgreSQL runner 通过 Node 模块解析寻找 Vitest，适配 npm workspace 提升安装。
- `7b2d79ce`：记录 area-kit CLI 可执行权限，避免 npm 安装后出现权限模式差异。

初次 npm ci 的锁文件错误与镜像 CDN 下载中断均保留日志，不计为成功。修正后将源 npm 缓存中与 lock integrity 匹配的 112 个不可变内容文件导入目标，缺少的两个平台 tarball 从官方 npm 下载并校验；**没有复制 node_modules**。最终新机 `npm ci --offline --no-audit --no-fund` 安装 512 个包成功（退出码 0）。缓存种子仅用于加速这次恢复，后续可使用正常联网 npm ci。

## 4. 新机验收结果

下表的构建、类型、默认测试、数据库测试及 pack 测试均在目标 `/www/node-kit` 执行，测试 SHA 为 `0ea32e3c9953ffbae47df8628a7fc8fc9d696bc5`。其后只有 CLI 文件模式和本次文档变化，复用这些结果。每项命令、退出码和 SHA 见 evidence 中的 `*-result.json`，原始输出见对应日志。

| 检查 | 实际结果 |
| --- | --- |
| area / addr-parse / sms / auth / sku build 与 typecheck | 两组命令均退出 0 |
| area-kit 默认测试 | 18 文件，145 案例通过 |
| addr-parse-kit 默认测试 | 4 文件，77 案例通过 |
| sku-kit 默认测试 | 20 文件，26 案例通过；不宣称额外 PostgreSQL 验收 |
| auth-kit 默认测试 | 8 文件，34 案例通过 |
| sms-kit 默认测试 | 34 文件，241 案例通过，含现有 Next 兼容性与 e2e |
| auth-kit PostgreSQL / Redis 集成 | 1 文件，12 案例通过 |
| sms-kit 定向 PostgreSQL 集成 | 3 文件，31 案例通过：system-auth-service、dispatch-recovery、receipt-service |
| area-kit PostgreSQL | 9 文件，97 案例通过 |
| addr-parse-kit PostgreSQL | 1 文件，9 案例通过 |
| auth / sku / addr-parse test:pack | 退出 0；addr-parse 包含仓库外安装、宿主 tsc、禁止客户端导入 server、Next 生产构建、认证→解析→校验→确认、断网重启与限流 |
| 7 个包的服务端编译入口加载 | 全部成功；ai / oss 限于现有产物 |
| Registry 归档、HTTP、认证、实际安装 | 均通过，见第 2 节 |
| Chromium 环境与 Registry 页面 | 实际启动成功、页面展示迁移包；有截图及 browser-result.json |

默认测试合计 **523** 案例；另列隔离集成测试 **149** 案例。未将 pack 内的脚本断言重复计数。area / addr-parse / sku 默认测试实际调用 **agy，模型 gemini-3.8-flash** 执行，并交叉核对结果文件和原始日志。主执行沿用当前 Codex 会话；依据官方模型指南及本机 model-selection.md，常规迁移执行建议 Sol，未声称切换会话模型。

隔离镜像版本经过实际服务端查询：

- PostgreSQL 18.6：`postgres@sha256:edb0c08dc33befd0262ab3b5cf1c4f3f8cfd8b09e88c05b45adee29d6761ddb6`
- Redis 8.2.10：`redis@sha256:e5f23377739f95a2f530b9c99f93accb4f634577f09d00a7d8e0638f2fdf69e0`

## 5. 开始开发

```bash
# 源机连接；无需把 SSH 私钥传到目标。
ssh -i ~/.ssh/66_meteor -o IdentitiesOnly=yes meteor@192.168.0.66
cd /www/node-kit
git status --short

# 已完成首次安装。后续需要重新安装时：
npm ci --prefer-offline --no-audit --no-fund

# 目前可进行源码开发的五个包，按依赖顺序构建。
npm run build --workspace area-kit --workspace addr-parse-kit --workspace sms-kit --workspace auth-kit --workspace sku-kit
npm run typecheck --workspace area-kit --workspace addr-parse-kit --workspace sms-kit --workspace auth-kit --workspace sku-kit

# 按本次改动范围选择相应 workspace 测试，不必每次全跑。
npm test --workspace auth-kit
npm run test:integration --workspace auth-kit

# 验证私有源认证与现有标签，不触发发布。
npm --userconfig /www/node-kit/.npmrc.local whoami
npm --userconfig /www/node-kit/.npmrc.local view sms-kit dist-tags --json
npm run registry:logs
```

项目是包 monorepo，没有统一业务站点或统一应用启动命令。消费项目改为 `http://192.168.0.66:4873` 时，应各自保存旧配置与 lockfile，并采用适合其项目的 scoped registry 配置。此次没有修改其他消费项目，也没有改变目标全局 npm 配置。

## 6. 备份、证据与回滚

| 位置 | 内容 |
| --- | --- |
| 源 `/home/node-kit` | 继续保留当前代码、原 `.tmp`、原 Registry storage 和运行服务 |
| 源 `/home/meteor/node-kit-migration-20261022` | 整合前 Git refs、工作树、补丁及准备阶段清单，保持原备份不变 |
| 源 `/home/meteor/node-kit-transfer-20261022` | Registry 一致性归档、镜像、缓存种子、最终 bundle / manifest、源侧 evidence 与目标 evidence 副本 |
| 目标 `/www/backups/node-kit-migration-20261022` | 原准备阶段备份副本 |
| 目标 `/www/backups/node-kit-transfer-20261022` | 本次传输归档、最终 bundle / manifest、验收 evidence、源侧 source-evidence 副本、独立消费安装目录 |

本次执行备份的 `final-SHA256SUMS` 校验最终 bundle、manifest、执行报告和主要传输归档；`transfer-SHA256SUMS` 保留初始 Registry 快照校验。目标测试日志已复制回源机 `target-evidence/`，不会覆盖源侧同名过程日志。

回滚时先停止新机发布，把开发连接与消费项目 Registry 配置恢复到各自保存的源机值；源 Registry 仍在线。若新机已发布新版本，先单独备份新 storage 并核对增量，不能直接覆盖或丢弃。源码可在新目录从最终 bundle 或整合前 bundle 恢复；旧工作树未提交内容查原归档和 patch，不对源机执行 reset --hard。此次未删除源机数据、测试容器或共享数据库，也未运行 Docker prune。

## 7. 明确边界

- **ai-kit、oss-kit 缺 src / test / scripts**：已迁移现有 dist 和 Registry 包并通过入口加载；完整源码开发验收仍需找回原源码。因此不把根级全量 build/typecheck 当作已通过。
- 源机受权限限制的 `/home/chenjq/.codex/worktrees/node-kit-auth-source` 和对应临时分支仍保留，已有备份且提交已在 master。其他已授权清理结果见原方案；本次保留源机回滚资产。
- 五级地区完整 CSV 不在仓库；本次 PostgreSQL 测试使用既有测试数据，未宣称完成全国数据导入或完整地区浏览器业务验收。
- 未执行真实短信、OSS、AI 供应商调用；未修改其他宿主项目、共享业务数据或 GitHub 分支。

结论限定为：**代码与 Registry 迁移完成；五个有源码包的新机开发环境通过上述验收；两个缺源码包保持可消费产物状态。**
