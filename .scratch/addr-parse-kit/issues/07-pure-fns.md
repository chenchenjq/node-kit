# 07 — 浏览器安全纯函数：模式转换/校验/拼接

Status: done

`.` 出口：`toWithStreet/toWithoutStreet`（新对象、幂等 streetFolded、村名等保留在 detail）、`validateParsedAddress`（代码名称冲突/路径失效/人工修正校验，走 provider.validatePath 的纯结构前置检查）、`formatAddress/formatWithRecipient`（不出现 null/undefined、不虚构、residual 尾部并示）。无 IO、不 import SDK、单测覆盖 §5 全部规则。

## Comments

- 完成证据：`toWithoutStreet/toWithStreet` 往返幂等且深拷贝复原（宿主内 `deepEqual(restored, first)`）；`formatAddress`/`formatRecipientLine`/`validateAddressIntegrity` 由单测与文档示例编译共同验证。
- 2026-09-22 浏览器验收时发现一处文档欠精确并补齐：并回会在街道原文与明细之间插入一个分隔空格（`src/transform.ts:25` 的 `` `${text} ${original}` ``），
  因此 `withoutStreet` 与 `withStreet` 两种模式的 `formatAddress` 输出可能只差这个空格，复原依赖 `streetFolded.restoredDetail` 而非重新解析。
  README 模式转换段与 AI-USAGE 行为规则已写明「不要用拼接结果逐字比对判断地址没变」，并在 `test/core.test.ts` 的并回用例里固化两条断言
  （`detailedAddress === "粤海街道 " + 原明细`；两种模式拼接去空白后逐字相等）。行为本身未改动。
