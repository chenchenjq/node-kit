# 12 — Store 契约、安全与真实 PostgreSQL 验收

Status: ready-for-agent

建立 `sku-kit/testing` Store 契约套件及 Testcontainers PostgreSQL 18 固定摘要测试，覆盖锁、并发、回滚、版本、历史、幂等和所有 DB 约束；补齐越权、跨作用域/跨 SPU 注入、错误脱敏、供应价泄露、库存权威和浏览器边界测试。测试数据不得包含真实业务或个人信息。

验收：默认 Store 通过全套契约；并发 100/101、重复请求和宿主事务锁顺序有实测；browser build 对 server/postgres/testing 失败；消费者 bundle 无 pg/Drizzle/供应价实现；未执行的 live 集成明确标注。

Depends on: 04, 05, 06, 07, 08, 09

## Comments
