# 11 — Next.js 参考宿主管理与展示流程

Status: ready-for-agent

在 examples 中建立 Next.js 16 参考宿主，演示可信 scope/auth 解析、宿主拥有 SPU 的同事务首次保存、HTTP DTO 适配、管理编辑页、商品详情选择器、SPU 图片回退和宿主实际售价/可用性投影。示例不得成为 sku-kit 运行时依赖，也不得被描述为完整商品平台或真实业务集成。

验收：新 SPU 无规格与多规格两条流程可运行；浏览器不能提交 scopeKey/供应价读取权限；完整选择只提交 skuId，服务端重新校验；参考外部库存/图片使用明确标注的 fake 端口，不冒充联调。

Depends on: 06, 07, 08, 09, 10

## Comments
