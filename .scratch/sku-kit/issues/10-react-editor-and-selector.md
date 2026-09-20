# 10 — 受控 React 编辑器与规格选择器

Status: ready-for-agent

实现 `SkuEditor` 与 `SkuSelector` 最小参考组件。编辑器覆盖规格编辑、改名/替换、组合上限与勾选、差异/转换预览、逐 SKU 配置、批量填充、加载/错误/冲突和未保存提醒；选择器只消费安全 DTO，输出选择及完整命中 skuId。网络、授权、上传、库存与确认 UI 通过 props/slots 注入。

验收：Testing Library/user-event 覆盖受控更新、键盘操作、fieldset/radio 或等价语义、标签和错误关联、冲突焦点恢复、不自动选第一项、图片回退、未知/缺货/不存在组合的不同呈现。组件包不导入 server/postgres。

Depends on: 02, 03, 09

## Comments
