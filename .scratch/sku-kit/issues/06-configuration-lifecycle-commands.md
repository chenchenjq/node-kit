# 06 — 配置预览、保存与生命周期命令

Status: ready-for-agent

实现 `previewConfigurationChange`、`saveConfiguration`、`setSkuStatus`、`archiveSku`、`restoreArchivedSku`。保存接收完整目标结构和三态补丁，在服务端重算 diff；首次无规格保存创建默认 SKU，首次多规格保存直接创建真实组合；处理 draftKey→ID、显式恢复、容量、SPU 改码、结构/配置双版本与模式转换前置检查。

验收：读取/预览不写库；重复首次保存幂等；保留组合不丢配置；新增 SKU 默认停用/空价/空图；移除归档不删除；恢复沿用 ID/编码；默认↔多规格不迁移库存；任一版本或前置条件失败全部回滚。

Depends on: 03, 04, 05

## Comments
