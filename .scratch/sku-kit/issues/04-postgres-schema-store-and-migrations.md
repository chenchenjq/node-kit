# 04 — PostgreSQL Schema、迁移与低级 Store

Status: ready-for-agent

实现 spec §7、§8、§11 的可信 schemaName Schema factory、显式 SQL 迁移、八张表、复合外键/唯一/check 约束、Pool Store、宿主 `PoolClient` 写绑定、SPU 事务锁、`nextSequence` 分配和回滚。Store 只暴露事务内锁定/读取/写入原语，不复制应用层领域规则；官方迁移不外键绑定宿主 SPU 表，也不自动运行。

验收：真实 PostgreSQL 验证作用域/组合/编码/序号/默认身份唯一、跨 SPU 值注入失败、金额不静默舍入、第 100 个可分配且第 101 个失败、并发初始化不重复、失败事务不占号、宿主事务可统一回滚。

Depends on: 01, 02

## Comments
