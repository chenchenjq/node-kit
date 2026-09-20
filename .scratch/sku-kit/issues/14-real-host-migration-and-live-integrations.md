# 14 — 真实宿主迁移与库存/图片联调

Status: needs-info

读取真实宿主的 SPU/SKU、价格、库存、图片、权限和打包实现，选择“迁入默认 PostgreSQL Store”或“宿主 Store 继续做唯一写权威”，制定一次性迁移与回滚方案；完成真实外部库存、上传/图片 resolver、宿主发布/成交价投影及生产迁移演练。禁止建立双写体系。

需要的信息：宿主仓库或可审核 Schema/API、历史 SKU/编码样本、库存权威与版本协议、图片稳定引用、权限模型、订单快照约束、迁移窗口及生产审批流程。在这些信息提供前，不得标为完成或用参考 fake 代替联调。

Depends on: 13 and external host information

## Comments
