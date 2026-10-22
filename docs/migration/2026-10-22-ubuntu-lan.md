# node-kit 局域网开发迁移方案与准备清单

盘点日期：2026-10-22（Asia/Shanghai）。源目录 `/home/node-kit`，目标 `meteor@192.168.0.66:/www/node-kit`，SSH 私钥位于源机 `~/.ssh/66_meteor`。

本次已实施本地代码整合、备份、可执行范围内的工作树／临时分支清理；目标机仅做只读检查。**尚未传输项目、恢复数据库、停止旧 Registry、启动新 Registry、切换消费项目或推送 GitHub。** 下列迁移命令属于待执行方案。

## 1. 结论与准备清单

- [x] 盘点全部本地分支、5 个工作树及未提交内容；整合到 `master`。
- [x] 保存清理前 Git bundle、Git 管理目录、4 个附加工作树文件、未提交补丁和逐文件 SHA-256；另存主目录 `.tmp`。
- [x] 对合并涉及的 area-kit、sms-kit 做类型检查、构建和测试；核查三个包的打包内容。
- [x] 通过指定密钥连接目标机，确认 `/www` 可写、项目目录尚不存在、4873 端口未占用。
- [x] 盘点 PostgreSQL、Redis、Testcontainers、Verdaccio 及持久化目录。
- [ ] 清理因权限受阻而保留的旧 auth 工作树及关联分支，见第 3 节。
- [ ] 找回 ai-kit、oss-kit 的源码、测试和构建脚本；当前仅有编译产物，无法完成这两个包的源码开发验收。
- [ ] 在迁移窗口暂停包发布，备份并恢复约 1.8 GiB 的 Verdaccio storage，核对版本、标签及认证。
- [ ] 在目标目录重新安装依赖，验证五个有源码的包及实际消费项目。
- [ ] 完成 PostgreSQL 18.6 / Redis 8.2.10 的隔离兼容性验收。源机 PostgreSQL 17 测试通过不能代替该项。
- [ ] 消费项目切换 Registry 地址并验证后，才考虑退役源机 Registry。

## 2. 代码、工具与目标环境

项目是 npm workspaces 私有包 monorepo，非单个 Web 应用；没有统一的应用启动端口和业务数据库。仓库地址为 `https://github.com/chenchenjq/node-kit.git`。

| 包 | 整合后版本 | 用途及交付状态 |
| --- | --- | --- |
| auth-kit | 0.3.5 | 认证；有源码、测试及已跟踪 dist |
| sms-kit | 0.0.20 | 短信、OTP、回执、状态协调；有源码及已跟踪 dist |
| area-kit | 0.0.4 | 五级地区数据与配送地区适配器；有源码、迁移 SQL 和固定 MCA JSON 快照 |
| addr-parse-kit | 0.0.0 | 地址解析；有源码、测试，集成测试依赖 area-kit 构建产物 |
| sku-kit | 0.0.0 | SKU 配置及 PostgreSQL 存储；有源码、测试和迁移 SQL |
| ai-kit | 0.0.0 | 只有 package.json、dist 和 artifacts；缺源码、测试、scripts |
| oss-kit | 0.0.0 | 只有 package.json、dist 和 artifacts；缺源码、测试、scripts；本次保留许可证改动 |

应一并保留 `docs/`、`.scratch/`、迁移 SQL、快照和锁文件。`CONTEXT-MAP.md` 中 ai-kit、auth-kit、oss-kit、area-kit、sms-kit 的 CONTEXT.md 链接当前缺少对应文件；此处如实记录，不用迁移任务重建领域文档。

根目录同时存在 package-lock.json 和 pnpm-lock.yaml；现有 root scripts 使用 npm workspaces，本方案按 **npm ci** 恢复，以 package-lock.json 为准，不混用包管理器。不复制 node_modules；重新安装保留工作区符号链接和目标机依赖。

| 项目 | 源机实测 | 目标机实测 |
| --- | --- | --- |
| 系统 / 架构 | 当前开发主机 | Ubuntu 24.04.4 LTS / x86_64 |
| Node.js | 22.22.2 | 22.23.3，满足严格包要求 `>=22.22.1 <23` |
| npm | 10.9.8 | 10.9.9 |
| Docker / Compose | 已能运行 Testcontainers | 29.9.0 / v5.6.1，meteor 可访问 daemon |
| PostgreSQL | 共享容器 scm-postgres-1，postgres:17-alpine | 服务端实测 18.6，5432，数据目录 `/data/postgresql/18/main` |
| Redis | 6379、6380 两个共享实例 | 服务端实测 8.2.10，127.0.0.1:6379 |
| 目标目录 | `/home/node-kit` | `/www` 可写，`/www/node-kit` 尚不存在 |
| 可用磁盘 | 备份已生成 | `/www` 所在文件系统约 186 GiB 可用 |

目标机还运行 SCMHub 的 PostgreSQL 5433 / Redis 6381 等服务，不能占用或重建这些实例。目标普通系统用户 meteor 没有同名 PostgreSQL role；通过 `sudo -n -u postgres psql` 完成了版本只读确认。这不等于已创建 node-kit 数据库账号。

## 3. master 整合、备份与工作树清理

起点为 `main=571b745e`、`master=f18b4341`。先将 master 快进至 main，再整合工作树独有的未提交内容：

- area-kit：配送地区适配器、固定快照、测试、入口和版本 0.0.4。
- area-kit / oss-kit / sms-kit：许可证及打包清单。
- sms-kit：发送前持久化 attempt、SYSTEM 回执／恢复／协调、租户范围保护及对应测试。
- 冲突处理：保留 master 后续增加的 `verifyAndConsume` 原子验证接口及既有 `PgSystemSmsLifecycle` 导出；保留 0.0.20，不回退到工作树的 0.0.18；对齐锁文件与已跟踪 dist。

代码整合提交 `3df78f07b9681a5bcbfc58f0ceae97b3bc8a0e07`；打包测试断言修正提交 `78ac2801`。本文所在文档提交不改变已测实现。未重新发布包，因此 master 的新增实现与 Registry 上既有同版本 tarball **不是同一产物**；将来发布应按版本流程新增版本，不能覆盖旧包。

恢复目录：`/home/meteor/node-kit-migration-20261022`，权限 0700。

| 文件 / 目录 | 内容 |
| --- | --- |
| repository-before.bundle | 清理前全部 Git refs，已执行 bundle verify |
| git-admin-before.tar.gz | 清理前 `.git`，包括 worktree 注册和原索引 |
| worktrees/*.tar.gz | 四个附加工作树的源码、未跟踪文件、dist、文档和证据；排除可重建 node_modules |
| primary-tmp.tar.gz | 主目录原有 `.tmp`，不混入代码提交 |
| evidence/*-sha256.json | 工作树文件逐文件校验；归档后回读 tar 校验，删除前复查源文件 |
| evidence/*-unstaged.patch / *-staged.patch | 清理前未提交与暂存改动 |
| evidence/cleanup-journal.json | 逐项删除结果和权限阻塞 |
| migration.bundle / migration-manifest.json | 最终 master / main 传输包及最终 SHA、完整性清单 |

已删除的工作树（原绝对路径不再可运行）：

1. `/home/meteor/.codex/worktrees/node-kit-velox-internal-license`
2. `/home/node-kit/.worktrees/area-kit`
3. `/home/node-kit/.worktrees/sms-management-phase1-kit`

已合并且删除的本地分支：`codex/area-kit`、`codex/auth-kit`、`codex/node-kit-velox-internal-license`、`codex/sms-kit-20260913`、`codex/sms-management-phase1-kit`、`release/sms-kit-v0.1.0`。清理前均确认属于 master 祖先。

保留 master 和长期分支 main；没有删除远端分支或修改 GitHub 默认分支，也没有推送。因此新机应从本次 bundle 的 **master** 恢复，而不是直接把远端 main 当作整合结果。

**未完成清理：** `/home/chenjq/.codex/worktrees/node-kit-auth-source` 及 `codex/auth-kit-source-restore`。该工作树仍被锁定，当前账号可读但无父目录及工作树写权限，源机 `sudo -n` 要求密码。其提交已进入 master，文件和 Git 管理信息已经备份；保持注册与分支，避免留下不完整删除。由具有源机 sudo 权限的用户核对工作树仍无新增改动后执行：

```bash
sudo git -c safe.directory=/home/node-kit -C /home/node-kit worktree unlock /home/chenjq/.codex/worktrees/node-kit-auth-source
sudo git -c safe.directory=/home/node-kit -C /home/node-kit worktree remove /home/chenjq/.codex/worktrees/node-kit-auth-source
git -C /home/node-kit branch -d codex/auth-kit-source-restore
```

不要使用 `--force` 绕过这一步可能发现的新改动。引用已移除工作树的历史测试证据应查阅归档；重新测试必须改用 `/home/node-kit` 或新机 `/www/node-kit`。

## 4. 数据库、隔离环境、容器及数据目录清单

### 4.1 PostgreSQL

在源机监听 5432 的共享 PostgreSQL 实例中读取数据库目录及相关 schema：共 23 个非模板数据库，**未发现 node-kit 专用常驻数据库**。相关表主要存在于宿主库：

| 数据库 | 关联表 / schema | 处理 |
| --- | --- | --- |
| scm | sms_kit；另有 public.oss_config 等宿主表 | 属于 SCM，不随包仓库迁移 |
| hb_oms | auth_kit、sms_kit 等 | 属于 OMS，不随包仓库迁移 |
| velox-dev | area_kit、sms_kit、public.auth_* 等 | 属于 Velox，不随包仓库迁移 |
| oms / CRM 及其历史验证库 | 宿主认证、SKU 或 AI 表 | 不作为 node-kit 测试资产处理 |

详细脱敏结果见 `evidence/postgres-kit-schema-inventory.json`。两个 OMS 历史数据库在元数据扫描时不可连接，未修改；这不影响 node-kit 已识别测试容器清单，但不把未检查对象声明为空。没有读取业务记录或导出这些宿主库。

node-kit 各包由宿主注入存储、连接、schema 和迁移流程，没有统一根级 `.env`／自动启动的业务库。本次未发现项目实际 `.env*` 配置文件，发现的是 `.npmrc.local.example`。`~/.npmrc` 发布凭据不提交到 Git，应在新机重新登录 Registry。

### 4.2 已存在的相关容器

| 容器 | ID | 镜像 / 状态 | 数据 / 归属 / 处理 |
| --- | --- | --- | --- |
| node-kit-verdaccio | 7ba03f530c0c | verdaccio/verdaccio:5；运行且健康；实测 5.33.0 | 正式开发 Registry，4873；必须迁移 bind storage，保留运行 |
| brave_yalow | 734b1a4ea824 | postgres:17-alpine；Created | POSTGRES_DB=sms_kit_test；Testcontainers 12.1.0；无持久卷、未启动，没有已初始化数据库可导出；仅盘点保留 |
| priceless_cray | 9aeffea2a36b | postgres:17-alpine；Created | 同上，另一个测试会话；仅盘点保留 |
| test_bg | 4fb165317e9c | redis:7-alpine；Created | 无项目标签，归属不能确认；卷 `cea676b0b9c862833c282bc8a66318319203630d773faf8cb7de468666f2d58c`；不删除、不迁移 |

两个 PostgreSQL 容器 session-id 分别为 `7b2fe788c641`、`17b55ef00e8f`。本次验证临时创建的 PostgreSQL / Ryuk 容器在测试结束后已回收；结束时相关清单与上述四项一致，见 `evidence/containers-after-tests.json`。本次没有删除既有数据库、容器、卷，没有执行 Docker prune。

### 4.3 测试隔离环境

| 包 / 入口 | 隔离方式 | 迁移要求 |
| --- | --- | --- |
| sms-kit 集成与部分 e2e | Testcontainers `postgres:17-alpine`；sms_kit_test；随机映射端口；tmpfs | Docker 可用；每次新建销毁，不迁移测试数据库 |
| auth-kit hardening | 默认 PostgreSQL 17 与 redis:7-alpine 一次性容器，auth_test | 可接受 SCM_AUTH_TEST_DATABASE_URL / SCM_AUTH_TEST_REDIS_URL；不要设置成任何宿主真实实例 |
| area-kit PostgreSQL / full / pack / browser | 固定镜像 digest `postgres@sha256:54451ecb8ab38c24c3ec123f2fd501303a3a1856a5c66e98cecf2460d5e1e9d7`；area_kit_ephemeral_test；tmpfs | 仅接受 runner 生成的 AREA_KIT_TEST_POSTGRES；剥离 PG* / DATABASE_URL |
| addr-parse-kit PostgreSQL | 同一固定 digest；area_parse_kit_ephemeral_test；tmpfs | ADDR_PARSE_KIT_TEST_POSTGRES；先构建 area-kit |
| sku-kit | 当前默认 Vitest / pack | 无独立常驻数据库资产；不把历史未验收的 PG 结果当作成功 |
| ai-kit / oss-kit | package.json 声明测试命令，实际 scripts / test 缺失 | 必须先恢复源码和测试入口，不能以 dist 存在认定测试可执行 |

两个固定 digest runner 的实际服务端版本需要运行时 `SHOW server_version` 确认，不能仅凭 digest 名称认定为目标 18.6。现有脚本没有统一的 PG/Redis 镜像环境变量覆盖入口。目标兼容性验收需明确调整测试镜像到 18.6 / 8.2.10，并在新建隔离容器中运行；不要为了复用脚本将测试指向共享 native 数据库。

源机 Redis 6379 的 db14 有 121 keys，6380 的 db0 有 1,384,685 keys（盘点时快照）；这些是共享实例，未确认存在 node-kit 独有持久数据，不复制整库 RDB/AOF，不执行 FLUSHDB。node-kit 的缓存／会话需求由宿主负责；新开发场景应新建独立测试实例，或明确分配账号与 key namespace。

### 4.4 必须保留的非 Git 数据

- `deploy/registry/storage/`：约 1.8 GiB，含 `data/` 的包 tarball、元数据、缓存以及 `htpasswd`；**尚未生成停写一致性备份**。
- `deploy/registry/conf/config.yaml` 与 docker-compose.yml 已纳入 Git；Registry 使用 bind mount，不存在项目专用 Docker named volume。
- area-kit 固定快照 `packages/area-kit/snapshots/mca-xzqh-2026-09-23.json` 已入 master，271,004 bytes，SHA-256 `a880ff2c2fc76f7e15c42dcef9476bd353fd48a2ce3ea397140358211636700e`。五级区域 CSV 不在包中；需要该数据的宿主按固定 manifest 准备，不能用 MCA 配送快照替代。
- `.tmp` 已独立归档，含旧候选 tarball／发布证据；四个工作树中的 `.local` 等证据在 worktrees 归档中。

Registry 当前标签需要原样保存：sms-kit `latest=0.0.18`、`scm-verified=0.0.20`；auth-kit `latest=0.1.1`、`scm-verified=0.3.5`；area-kit `latest=0.0.4`；其余四包 `latest=0.0.0`。不要为迁移运行 `registry:publish`，该命令会构建并发布，而不是恢复仓库。

## 5. 分阶段迁移步骤（尚未执行）

### A. 传输可恢复的代码与证据

先核对迁移清单中的 finalHead；若源目录有后续修改，重新生成 bundle 和清单。只在目标项目目录不存在时 clone；已存在时先盘点，不能覆盖。

```bash
# 源机执行：密钥只用于 SSH，不传给新机。
ssh -i ~/.ssh/66_meteor -o IdentitiesOnly=yes meteor@192.168.0.66 \
  'install -d -m 700 /www/backups/node-kit-migration-20261022'
rsync -a --no-owner --no-group \
  -e 'ssh -i /home/meteor/.ssh/66_meteor -o IdentitiesOnly=yes' \
  /home/meteor/node-kit-migration-20261022/ \
  meteor@192.168.0.66:/www/backups/node-kit-migration-20261022/
```

```bash
# 目标机执行。
set -e
cd /www/backups/node-kit-migration-20261022
sha256sum -c SHA256SUMS
git bundle verify migration.bundle
test ! -e /www/node-kit
git clone --branch master /www/backups/node-kit-migration-20261022/migration.bundle /www/node-kit
cd /www/node-kit
git remote set-url origin https://github.com/chenchenjq/node-kit.git
git rev-parse HEAD
git status --short
npm ci
```

`test` 失败时应停止，不继续 clone。新机 GitHub 认证另行配置；不能假定连接 66 主机的 SSH 私钥也具有 GitHub 权限。原 `.tmp` 证据留在备份目录，不需要恢复到源码目录。

### B. Registry 停写备份、恢复与验证

安排短维护窗口，暂停所有包发布，确认消费方可接受 Registry 短暂不可用。记录源容器镜像 digest，迁移时保持 Verdaccio 5.33.0 的同一镜像；不要把迁移与 Registry 版本升级混在一起。

```bash
# 源机：在维护窗口执行，备份失败时也必须恢复原服务。
set -e
cd /home/node-kit
docker compose -f deploy/registry/docker-compose.yml stop verdaccio
trap 'docker compose -f /home/node-kit/deploy/registry/docker-compose.yml start verdaccio' EXIT
tar -czf /home/meteor/node-kit-migration-20261022/registry-storage.tar.gz \
  -C /home/node-kit/deploy/registry storage
sha256sum /home/meteor/node-kit-migration-20261022/registry-storage.tar.gz \
  > /home/meteor/node-kit-migration-20261022/registry-storage.sha256
docker compose -f deploy/registry/docker-compose.yml start verdaccio
trap - EXIT
```

将新备份通过 SSH/rsync 单独同步到目标机并比对 SHA-256（源 hash 文件包含源机绝对路径，在目标机直接计算文件摘要后比较）。源服务恢复后继续冻结发布，直到新 Registry 验收并切换，以免备份后出现新版本未复制。

目标机用 sudo 解包以保留源容器所需 numeric UID/GID，路径为 `/www/node-kit/deploy/registry/storage`；先检查归档结构、所有权及目标不存在，再解包，不能覆盖已投入使用的新 Registry。不要用整目录 777 解决权限问题。

```bash
# 目标机：只适用于尚无 storage 的初次恢复。
set -e
cd /www/node-kit
test ! -e deploy/registry/storage
sudo tar --numeric-owner -xzf /www/backups/node-kit-migration-20261022/registry-storage.tar.gz \
  -C /www/node-kit/deploy/registry
npm run registry:up
curl --fail http://127.0.0.1:4873/-/ping
npm view sms-kit dist-tags --json --registry http://127.0.0.1:4873
npm view auth-kit dist-tags --json --registry http://127.0.0.1:4873
npm view area-kit dist-tags --json --registry http://127.0.0.1:4873
```

恢复前用镜像 inspect 比对源机记录的 image ID/digest；Compose 的 `:5` 是可变 tag，若两机不同则先加载源机导出的同一镜像。目标启动后还需验证真实下载 tarball 的完整性与锁定版本安装，不仅验证 `/‑/ping`。在新机 `npm login --registry http://127.0.0.1:4873`，不要把 token 写入报告或仓库。跨主机消费地址为 `http://192.168.0.66:4873`；目标机内部仍可用 127.0.0.1。核对 LAN 防火墙和 npm lockfile 中旧 tarball URL 后再切换消费项目。

### C. PostgreSQL / Redis 开发环境

本次无已识别的 node-kit 常驻业务库需要导入，优先保留“宿主注入连接 + 测试容器按需重建”的模式。不要迁移 SCM／OMS／Velox 的数据库或已有共享 Redis 数据。

如果后续需要 node-kit 独立演示宿主，再创建专属数据库（例如 node_kit_dev）、迁移角色和低权限运行角色；设置本机连接、明确 schema，按包迁移入口初始化。数据库名、凭据及宿主入口当前尚未创建，不能把本方案中的示例名当作已存在配置。

若未来另行纳入真实宿主数据迁移，应单独列明源库、依赖 schema、扩展、角色、行数／序列与脱敏要求；PostgreSQL 17 → 18 使用逻辑导出／恢复，不复制源 PGDATA。可采用 `pg_dump -Fc` 与 `pg_restore --exit-on-error --single-transaction --no-owner --no-acl`，恢复到预先创建的专用空库并验收 owner/ACL。跨 schema 外键依赖必须一起解决；不能只凭表名前缀抽取。参见 [PostgreSQL 18 SQL Dump](https://www.postgresql.org/docs/18/backup-dump.html) 与 [pg_dump](https://www.postgresql.org/docs/18/app-pgdump.html)。

### D. 目标开发验收与回滚

1. 校验 bundle、Git HEAD、快照哈希及归档 checksum；确认 master 和依赖安装正确。
2. 对五个有源码包执行定向 build/typecheck，按依赖顺序先 area-kit，再 addr-parse-kit；sms-kit、auth-kit、sku-kit 按各包命令验证。ai-kit、oss-kit 恢复源码前不能使用根级全量 build/typecheck 作为门禁。
3. 在目标机执行相关包默认测试及隔离 PostgreSQL / Redis 测试；按第 4.3 节处理 18.6 / 8.2.10 版本矩阵。浏览器验收还需安装项目实际 Playwright 版本要求的 Chromium 与系统依赖。
4. 校验 Registry 全部自有包的版本、dist-tags、tarball integrity；从目标 Registry 安装明确版本，验证消费项目加载。禁止把短信／OSS／AI live 测试混入默认验收，这些需要独立凭据及业务授权。
5. 通过后再逐个切换消费项目源地址。保存旧地址和 lockfile，切换失败时回退；旧 Registry 保持可恢复。新端已经发布的版本需先回收归档，不能直接丢弃。
6. 源码回滚可在新目录从 repository-before.bundle 取回旧 master/main；未提交内容在 worktrees tar 和 patch 中恢复。不要在源机脏目录执行 reset --hard，也不要直接覆盖在线 `.git`。

## 6. 本次验证及边界

| 检查 | 实际结果 |
| --- | --- |
| area-kit / sms-kit typecheck、build | 退出码 0 |
| area-kit 默认测试（agy） | 18 文件 / 145 案例全部通过；实际调用 gemini-3.8-flash；SHA 3df78f07；报告与原始日志交叉核对 |
| sms-kit 默认测试 | 初次 34 文件：240 通过、1 失败；失败为新增 LICENSE 未进入打包白名单 |
| sms-kit 失败项复验 | 修改白名单并断言 LICENSE 存在；SHA 78ac2801；1 文件 / 1 案例通过；其余 240 项代码、环境未变，复用结果 |
| sms-kit PostgreSQL 定向集成 | dispatch-recovery、receipt-service、system-auth-service，3 文件 / 31 案例通过；真实一次性 PostgreSQL 17 容器 |
| npm pack dry-run | area-kit 112 文件，oss-kit 28 文件，sms-kit 202 文件；许可证、快照与新增 JS 入口存在；未发布 |
| 完整性 / 清理 | bundle verify、归档逐文件 hash、删除前复查、分支祖先检查；git diff --check 通过 |

测试原始日志、退出结果与 agy 输出存于恢复目录 evidence。没有重新跑与整合无关的全仓测试；没有执行目标机 npm ci、源码构建、18.6 / 8.2.10 功能验收、Registry 恢复或 live 供应商测试。缺源码及旧工作树权限问题仍是明确的未完成项。

模型选择依据 [OpenAI 官方指南](https://developers.openai.com/api/docs/guides/model-selection) 与本机 model-selection.md：常规盘点／整合建议 Sol；本次主执行使用现有 Codex 会话，没有声称切换模型；部分测试实际通过 agy 指定 gemini-3.8-flash。所有“通过”均限定于上表实际执行范围。
