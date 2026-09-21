# 06 — 兜底提取器与 initParser/parse/parseBatch 出口

Status: done

无候选时最小提取器（标签词+高置信手机/座机/+86/分机正则；提取不到留 null；不主动多行拆订单）。`initParser`（provider 校验、显式 datasetId/version、meta 组装）、`parse`、`parseBatch`（逐项 index/recordId、单条错误不影响整批）。regionHint 过滤排序+冲突警示。

## Comments

- 完成证据：`initParser/parse/parseBatch` 与兜底候选在真实宿主（未安装 area-kit）内跑通，含批量逐条隔离（`recordId`、单条 `E_INPUT_EMPTY` 不影响同批）与全部输入错误码。
