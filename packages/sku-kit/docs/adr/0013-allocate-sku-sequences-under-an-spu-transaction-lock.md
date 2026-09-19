# 在 SPU 事务锁内分配 SKU 序号

官方 PostgreSQL Store 在 `READ COMMITTED` 事务中按作用域与 SPU 获取事务锁，并锁定商品配置状态行后读取、分配和增加 `nextSequence`；首次状态行创建也由同一锁串行化，唯一约束作为最终防线。序号更新与 SKU 创建一同提交或回滚，因此失败不会占号；宿主拥有事务时必须先锁自己的 SPU，再进入 SKU 锁，自定义 Store 必须通过等价并发契约测试。
