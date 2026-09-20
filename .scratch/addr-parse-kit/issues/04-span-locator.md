# 04 — 定位扫描与文本重建（Q22b）

Status: done

在 rawInput 上为引擎声明命中的每级 matchedText 定位真实区间（父子路径约束、最长匹配、重复地名按出现序消歧）。产出：各级 matchedRange、detailedAddress（含被剥离/可疑街道文本回并）、residualText（未归类原文，含空格标点）、ENGINE_DETAIL_MISMATCH 交叉核对警告。回归锚点：A4 顺德路街道、D4 别名残字、A9 重复地名。

## Comments

- 完成证据：span 不变量 `input.slice(begin,end) === matchedText` 在干净宿主内断言通过；`residualText`/`detailedAddress` 与警告码（`ENGINE_DETAIL_MISMATCH`、`TEXT_SPAN_UNRESOLVED`、`RESIDUAL_TEXT`）由 `test/core.test.ts` 覆盖，含回归锚点用例。
