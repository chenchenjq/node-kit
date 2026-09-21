# sms-kit Implementation Plan Suite

本目录把 `sms-kit` PRD 拆成四份顺序执行的实施计划。执行者必须先阅读 [PRD](../../../doc/prd/001-sms-kit.md)、[数据库设计](../../../doc/数据库设计.md) 和当前计划，再开始对应任务。

## 执行顺序

1. `2026-09-13-sms-kit-foundation.md`：npm workspace、核心领域、Ports、安全原语、PostgreSQL schema 与 Store。
2. `2026-09-13-sms-kit-aliyun-delivery.md`：阿里云配置测试、资源同步、发送、Worker、回执、补查和统计。
3. `2026-09-13-sms-kit-auth-security.md`：高风险 Challenge、证明消费和 Better Auth 适配。
4. `2026-09-13-sms-kit-next-admin-api.md`：公开 DTO、Node.js Route Handler、管理 API、端到端验证和交付文档。

每份计划必须在前一份计划的测试、类型检查和构建全部通过后执行。每个任务使用 TDD，小步提交；不得运行 `npm publish`。

## 依赖版本基线

以下版本来自 2026-09-13 的 npm registry 查询，首次安装后由根目录 `package-lock.json` 固定：

| 包 | 版本 |
| --- | --- |
| TypeScript | `7.0.2` |
| @types/node | `20.19.43` |
| Vitest | `5.0.0` |
| tsx | `4.23.13` |
| pg / @types/pg | `8.23.0` / `8.23.1` |
| Testcontainers | `12.1.0` |
| Zod | `4.6.4` |
| libphonenumber-js | `1.13.13` |
| @alicloud/dysmsapi20170525 | `4.6.0` |
| @alicloud/openapi-client / tea-util | `0.4.15` / `1.4.11` |
| Better Auth | `1.7.4` |
| server-only | `0.0.1` |
| Next.js / React / React DOM（兼容 fixture） | `16.3.5` / `19.3.0` / `19.3.0` |

## 交付覆盖

| PRD 能力 | 实施计划 |
| --- | --- |
| 私有包、TypeScript、ESM、浏览器拒绝导出与 Next.js 构建期 server-only | Foundation + Next Admin API |
| ORM 无关 Ports、PostgreSQL DDL/迁移/pg 适配器 | Foundation |
| 空库 bootstrap、版本 1 fixture 升级、迁移校验和保护 | Foundation |
| 全局单配置、运行数据租户隔离、单租户默认键 | Foundation + 各服务/API 计划 |
| 上下文绑定手机号/变量加密、幂等、派发令牌、租约、限流、策略与预算数据结构 | Foundation |
| 阿里云授权测试、分页同步、候选快照与导入 | Aliyun Delivery |
| `businessType`/双模板枚举映射与 `QuerySendDetails` 必填分页参数 | Aliyun Delivery |
| OTP 围栏直发、普通短信异步、租约恢复、受理未知、未匹配回执与补查 | Aliyun Delivery |
| 数据清理、脏日期统计重算、健康与指标事件 | Aliyun Delivery |
| 结构合法未匹配回执确认、可注入回调截止时间 | Aliyun Delivery + Next Admin API |
| 高风险验证、行锁单次证明、同库事务与跨库补偿 | Auth Security |
| Better Auth 真实类型契约、已有账号免密登录、密码重置与防枚举调度 | Auth Security |
| 管理权限、审计、API/DTO、Next.js Route Handler | Next Admin API |
| 双层测试、真实联调保护、Next 客户端导入失败契约、Node 20 无 Docker-in-Docker 验证与接入文档 | Next Admin API |
