# 05 — 服务上下文、授权、作用域绑定与幂等

Status: ready-for-agent

实现 `createSkuService` 的可信 `resolveScope`、细分 `authorize`、作用域配置绑定、actorRef、结构化观测 hook、脱敏基础设施异常和七天默认命令回执。浏览器 DTO 不含 scopeKey；首次 SKU 写入可原子创建 `sku_scope_config`，读取不得创建；权威键变化返回阻塞问题，不自动切换。

验收：每项授权独立测试；浏览器 scopeKey 注入无效；跨作用域查询/写入被拒；相同 commandId/载荷返回原安全结果，不同载荷冲突；回执只由显式维护函数清理；日志不含供应价、令牌、连接串或完整图片引用。

Depends on: 02, 04

## Comments
