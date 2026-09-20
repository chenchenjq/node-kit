# 08 — 库存权威端口与独立命令

Status: ready-for-agent

实现本地可读写、外部可读写、外部只读三种能力契约，批量 `known|unknown` 读取，以及 `setLocalInventory`/`setExternalInventory` 带版本绝对设置。SKU 普通保存不调用库存写端口；外部写和 SKU 事务分别反馈，不能宣称跨系统原子。提供作用域权威迁移/重新绑定所需的受控底层入口，但不实现自动迁移。

验收：本地新 SKU 数量 0/version 1；旧版本覆盖拒绝；只读模式拒写；外部无结果为 unknown 而非 0；写失败不伪装 unknown；改价格/图片/结构不覆盖库存；同一作用域权威键变化被阻止。

Depends on: 04, 05, 06

## Comments
