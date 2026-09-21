# 07 — 浏览器安全纯函数：模式转换/校验/拼接

Status: done

`.` 出口：`toWithStreet/toWithoutStreet`（新对象、幂等 streetFolded、村名等保留在 detail）、`validateParsedAddress`（代码名称冲突/路径失效/人工修正校验，走 provider.validatePath 的纯结构前置检查）、`formatAddress/formatWithRecipient`（不出现 null/undefined、不虚构、residual 尾部并示）。无 IO、不 import SDK、单测覆盖 §5 全部规则。

## Comments

- 完成证据：`toWithoutStreet/toWithStreet` 往返幂等且深拷贝复原（宿主内 `deepEqual(restored, first)`）；`formatAddress`/`formatRecipientLine`/`validateAddressIntegrity` 由单测与文档示例编译共同验证。
