# 05 — 候选映射与守卫规则

Status: done

SDK 候选 → AddressCandidate：槽位按 code→真实 level 重映射（Q23a：group 节点入 regionGroup 不占槽）；inferred 剥离（allowInferred 保留+强制 review）；道路后缀守卫；姓名守卫（NAME_MAY_BE_PLACE）；电话规范化仅作用确认片段+分机拆分+掩码标记；postalCode/idCard 不出口；多收件信息保留入 extra；status 纯结构分类；maxCandidates/输入校验（4096/100/默认5硬顶20）；不使用 SDK parseAddressBatch 与 minConfidence。

## Comments

- 完成证据：分组节点进 `regionGroup` 不占行政槽位、`allowInferred` 默认关闭、`maxCandidates` 越界显式报错、区域提示只收窄不覆盖（`HINT_CONFLICT`）均在 `test/core.test.ts` 与宿主内 smoke 断言里验证。
