# node-kit 本地私有 npm Registry (Verdaccio)

本项目使用 [Verdaccio](https://verdaccio.org/) 作为轻量级本地私有 npm Registry，满足 `node-kit` 多包管理体系下的本地发包、多项目测试、版本分发以及公共依赖缓存需求。

---

## 1. 核心特性

- **开箱即用**：基于 Docker Compose 容器化编排，数据与配置与宿主机目录持久化隔离。
- **高速上游代理 (Uplink)**：默认上游源为 `https://registry.npmmirror.com/`，公共依赖透明代理拉取并在本地高速缓存，兼顾私有包与公网生态。
- **Web 管理界面**：提供直观的 Web UI（默认地址 `http://localhost:4873`），可查看包信息、版本列表、README 与下载量。
- **权限与认证**：内置 htpasswd 认证，发布包需账号登录，访问/下载默认公开。

---

## 2. 快速起停与运维命令

在 `node-kit` 根目录执行以下命令即可：

| 操作 | 对应命令 | 说明 |
| :--- | :--- | :--- |
| **启动 Registry** | `npm run registry:up` | 后台启动 Verdaccio 容器，监听 `4873` 端口 |
| **查看运行状态** | `npm run registry:status` | 查看容器运行状态与健康检查 |
| **查看日志** | `npm run registry:logs` | 打印 Verdaccio 访问与运行日志 |
| **一键部署所有包** | `npm run registry:publish` | 自动构建并发布 workspace 下的所有包至本地 Registry |
| **停止 Registry** | `npm run registry:down` | 停止并移除容器（数据保留在 `storage/` 目录） |

---

## 3. 使用指南

### 3.1 本地开发者账号已配置
已自动在本地私有 Registry 中注册并配置默认账号：
- **用户名**：`meteor`
- **密码**：`meteor`
- **邮箱**：`meteor@localhost`

认证 Token 已写入全局 `~/.npmrc`，当前环境执行以下命令即可确认处于登录状态：
```bash
npm whoami --registry http://127.0.0.1:4873
# 输出: meteor
```

若需为其他开发者注册新账号或在其他机器登录：
```bash
npm adduser --registry http://127.0.0.1:4873
# 或登录已有账号
npm login --registry http://127.0.0.1:4873
```

---

### 3.2 在 node-kit 中发布包

#### 方式 A：一键部署所有包（推荐）
在项目根目录直接执行：
```bash
npm run registry:publish
```
该命令会自动扫描所有子包、按需构建产物，并安全发布至本地 Registry。

#### 方式 B：进入指定子包发布
进入需要发布的子包目录：

```bash
# 进入指定子包目录
cd packages/sms-kit

# 构建产物
npm run build

# 发布到本地私有 Registry
npm publish --registry http://127.0.0.1:4873
```

> **提示**：可以在子包的 `package.json` 中配置 `publishConfig`：
> ```json
> {
>   "publishConfig": {
>     "registry": "http://127.0.0.1:4873/"
>   }
> }
> ```
> 这样在包目录下直接执行 `npm publish` 会自动发布到该私有源。

---

### 3.3 在消费项目或宿主工程中安装依赖

#### 方式 A：单次安装指定源
```bash
npm install @node-kit/sms-kit --registry http://127.0.0.1:4873
# 或 pnpm
pnpm add sms-kit --registry http://127.0.0.1:4873
```

#### 方式 B：项目级配置（推荐）
在消费工程根目录创建 `.npmrc`（可参考根目录的 `.npmrc.local.example`）：
```ini
registry=http://127.0.0.1:4873/
always-auth=false
```
此时项目内的所有 `npm install` / `pnpm install` 会优先查询本地私有包，未命中的公共包自动由 Verdaccio 回源到 npmmirror。

---

## 4. 目录说明与备份

```
deploy/registry/
├── docker-compose.yml   # 容器编排定义
├── conf/
│   └── config.yaml      # Verdaccio 核心策略配置
├── storage/             # 包数据与 htpasswd 持久化目录（已加入 .gitignore）
│   ├── data/            # 发布的 npm 包 tarball 与元数据缓存
│   └── htpasswd         # 账号密文存储
└── README.md            # 本使用说明
```

- **数据备份**：只需定期备份 `deploy/registry/storage` 目录即可完整保存所有已发布的私有包与用户数据。
- **重置数据**：执行 `npm run registry:down` 后，清空 `deploy/registry/storage/` 目录并重启即可重置为全新状态。

