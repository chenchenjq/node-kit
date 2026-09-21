# 13 — 打包、三份核心文档与干净宿主验收

Status: ready-for-agent

实现文档示例类型检查和 `verify-pack`：构建、`npm pack`、检查 tgz 清单，在仓库外干净 Node/Next 宿主安装并运行默认 PostgreSQL、管理编辑和消费者选择流程。基于真实导出生成且只宣传 `README.md`、`DATABASE.md`、`AI-USAGE.md` 三份用户核心文档；AI-USAGE 保留原 Prompt 指定的业务开发提示词。

验收：tgz 不含源码测试、artifacts、node_modules、密钥或业务数据；干净宿主不依赖 workspace 链接；六入口、类型、迁移资产、浏览器隔离和参考流程实测；文档只声称实际执行结果并列出未验证项。

Depends on: 10, 11, 12

## Comments
