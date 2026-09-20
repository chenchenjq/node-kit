# Packages

| 包名 | 路径 | 用途 |
| --- | --- | --- |
| ai-kit | packages/ai-kit | 私有 AI 能力包：模型与供应商目录、内容生成、服务端管理及 React 集成。 |
| auth-kit | packages/auth-kit | 私有认证能力包：基于 Better Auth 的认证、密码、验证码及 Next.js/React 集成。 |
| oss-kit | packages/oss-kit | 私有对象存储能力包：阿里云 OSS、内容校验、凭据管理及 React 集成。 |
| sms-kit | packages/sms-kit | 私有 Node.js 短信基础包：阿里云短信、PostgreSQL 存储/迁移、验证与回执、Next.js 管理/任务 Handler；公开子路径为 `core`、`application`、`ports`、`security`、`postgres`、`aliyun`、`better-auth`、`next`、`next/types` 与 `testing`。 |
| area-kit | packages/area-kit | 私有五级区域数据导入、版本化查询/校验及 React 选择/管理包。 |
| addr-parse-kit | packages/addr-parse-kit | 私有中文收件地址解析包：复用宿主注入的区域快照，输出可确认的候选/警告/原文区间，提供层级输出模式转换、反向拼接与结构校验；公开子路径为根入口（类型 + 纯函数，浏览器可用）与 `server`（`initParser`、`ParseKitError`、`DEFAULT_LIMITS`）。不内置区划数据、不写数据库。 |
