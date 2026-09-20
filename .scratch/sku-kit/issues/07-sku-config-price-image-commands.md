# 07 — SKU 配置、价格、图片与批量复制

Status: ready-for-agent

实现 `patchSkuConfigurations` 与 `copySkuFields`：CNY 建议零售价/供应价、稳定图片引用、enabled/disabled、每 SKU configVersion、三态字段和 empty-only/overwrite。供应价读写使用独立授权，消费者 DTO 在类型和运行时均无供应价。提供图片 resolver 端口及可选 oss-kit FileReference 映射辅助函数，不硬依赖 oss-kit。

验收：不同 SKU 配置互不覆盖；null 与 0.00 区分；超范围/负数/超精度拒绝；供应价高于建议价只警告；默认批量填充不覆盖；overwrite 必须显式；库存字段无法进入命令；图片解析失败安全回退且不删除文件。

Depends on: 05, 06

## Comments
