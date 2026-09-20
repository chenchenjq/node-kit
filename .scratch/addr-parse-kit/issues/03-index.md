# 03 — 快照索引构建与版本缓存

Status: done

由 RegionSnapshot 构建树形 divisions（喂 createParser）+ `code→{level,kind,parent}` 查找表 + 名称定位索引。按 `datasetId+version` 键缓存复用；版本变化重建；初始化失败/版本不匹配显式报错；记录冷启动耗时。索引只含区域数据，不缓存收件文本。

## Comments

- 完成证据：`buildRegionIndex` 对空快照、重复代码、缺父级、层级非递增一律 `E_SNAPSHOT_INVALID`；`initParser` 对 Provider 形状/加载失败给 `E_REGION_INIT`，版本不一致给 `E_REGION_VERSION_MISMATCH`，无静默回退。缓存复用与冷启动成本由 `scripts/bench.mjs` 实测（同键第二次 0 ms、Provider 仍只加载 1 次）。
