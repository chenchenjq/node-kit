# 09 — 管理读取、历史读取与消费者投影

Status: ready-for-agent

实现 `getManagementConfiguration`、`getConsumerSelection`、`getSkuById`、`getSkuByCode`、`listSkusBySpu` 及批量 `ConsumerProjectionPort` 组合。管理、消费者和历史 DTO 分开；按作用域唯一编码读取；归档 SKU 只在授权历史/管理视图出现；选择图使用宿主 visible/selectable/salePrice/availability 结果，不推断发布、成交价或可购买状态。

验收：供应价不会出现在消费者序列化结果；停用/归档默认不进入消费者图；投影缺项安全未知；部分选择过滤正确；完整选择唯一命中；图片和 complete/partial/unknown 价格范围符合 spec。

Depends on: 03, 05, 07, 08

## Comments
