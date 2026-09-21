# 落库约定（PostgreSQL + Drizzle 示例）

`addr-parse-kit` 不写数据库：解析结果是纯内存对象，持久化、迁移、连接池、权限与备份全部归宿主。
本页给出**推荐结构**与 Drizzle 示例；示例只保证在干净宿主里通过 `tsc`，不代表已对任何真实库执行迁移。

## 存储模型

1. **只存一种归一结构**：以 `withStreet`（省/市/区/街道 + 详细地址）落库；`withoutStreet` 是读出来的**视图**，
   用 `toWithoutStreet(candidate)` 现算，不另存一份，避免两组字段互相漂移。
2. **名称快照与代码同存**：每个层级同时保存 `*_code` 与 `*_name`。区域数据换代后**不回写**历史名称，
   历史行永远能还原当时的显示；需要新名称时按 `regionDatasetId/regionVersion` 反查对应快照，或由宿主单独提示“区域已更名”。
3. **解析建议 ≠ 确认结果**：`parse_status`/`parse_warnings` 记录机器结论，`confirmed_at` 只在用户明确确认后写入；
   `confirmed_at is null` 的行不得当作已确认地址使用。
4. **手机号不是唯一键**：一个号码对应多人多地址是常态。`phone` 上只建普通检索索引，不加唯一约束；
   业务去重键由宿主自定义（例如对 `recipient_name + phone + district_code + detailed_address` 取哈希）。
5. **代码与号码一律字符串**：区域代码可能以 0 开头、手机号可能是掩码（`138****0000`）或带分机。
   一律 `varchar/text` 存储，不用整型、不做数值转换、不补零、不截断前导零。
6. **敏感字段按宿主策略**：姓名/号码属个人信息，是否加密、脱敏展示与留存期由宿主合规决定；本包不提供加解密。
7. **禁止的写法**：把整段收件原文塞进单个 `text` 列（无法按层级检索与复核）、用 `confidence` 当业务真值、
   把浏览器提交的 `regionVersion` 当落库版本（必须取服务端 `result.meta`）。

## 推荐表：`recipient_address`

编码：数据库/表/列一律 `UTF8`。PostgreSQL 的 `varchar(n)` 按**字符数**计（不是字节），中文无需放大倍数。

| 列 | 类型 | 空 / 默认 | 索引 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | `uuid` | not null, `gen_random_uuid()` | 主键 | 记录身份 |
| `owner_scope` | `varchar(64)` | not null | `(owner_scope, confirmed_at desc)` | 宿主业务归属（租户/店铺/业务域），语义由宿主定义 |
| `owner_id` | `varchar(64)` | nullable | `(owner_scope, owner_id)` | 归属主体（用户/订单等） |
| `recipient_name` | `varchar(64)` | nullable | — | 姓名原文；多数输入只有地址，故可空 |
| `phone` | `varchar(32)` | nullable | 普通索引，**禁止唯一** | 可拨号码原文 |
| `phone_extension` | `varchar(16)` | nullable | — | 分机号 |
| `masked_phone` | `varchar(32)` | nullable | — | 只有掩码号码时存这里，避免与可拨号码混淆 |
| `province_code` | `varchar(12)` | not null | — | 一级代码 |
| `province_name` | `varchar(64)` | not null | — | 一级名称快照 |
| `city_code` / `city_name` | `varchar(12)` / `varchar(64)` | nullable | — | 二级；直辖市可为空（分组节点见下） |
| `district_code` | `varchar(12)` | not null | `(district_code)` | 三级，多数业务的最小落库层级 |
| `district_name` | `varchar(64)` | not null | — | 三级名称快照 |
| `street_code` / `street_name` | `varchar(12)` / `varchar(64)` | nullable | `(street_code)` | 四级；`withoutStreet` 视图下仍在库中 |
| `group_code` / `group_name` | `varchar(12)` / `varchar(64)` | nullable | — | 直辖市的“市辖区”、省直辖县级分组等**非行政槽位**节点 |
| `street_matched_text` | `varchar(64)` | nullable | — | 街道在原文中的文本；用于精确复现 `withoutStreet` 折叠 |
| `path_codes` | `jsonb` | not null, `'[]'` | — | 路径代码数组快照（数组保序，对象不保序） |
| `path_names` | `jsonb` | not null, `'[]'` | — | 路径名称数组快照 |
| `detailed_address` | `text` | not null | — | 行政区消费后的剩余正文（门牌、房号、备注原样保留） |
| `residual_text` | `text` | nullable | — | 未被消费的原文片段，排查解析质量用 |
| `region_source` | `varchar(64)` | not null | `(region_dataset_id, region_version)` | Provider `source` |
| `region_dataset_id` | `varchar(64)` | not null | 同上 | 数据集身份 |
| `region_version` | `varchar(64)` | not null | 同上 | 解析时钉住的区划版本 |
| `code_scheme` | `varchar(64)` | not null | — | 代码方案；跨方案的代码禁止直接比较 |
| `parser_version` | `varchar(32)` | not null | — | 本包版本（`meta.parserVersion`） |
| `sdk_version` | `varchar(32)` | not null | — | 底层解析引擎版本（`meta.sdkVersion`） |
| `candidate_id` | `varchar(64)` | nullable | — | 被确认的是第几条候选，便于回溯歧义处理 |
| `parse_status` | `varchar(16)` | not null, `check ∈ matched/ambiguous/partial/unmatched` | — | 机器结论 |
| `parse_confidence` | `numeric(5,4)` | nullable | — | 只用于候选排序，**不是可配送证明**；排序依据变化时不得改动历史行 |
| `parse_warnings` | `jsonb` | not null, `'[]'` | — | 警告码数组，如 `["AMBIGUOUS","RESIDUAL_TEXT"]` |
| `requires_review` | `boolean` | not null, `true` | 部分索引 `where requires_review` | 歧义/推断/残差都会置真 |
| `manual_edits` | `boolean` | not null, `false` | — | 用户是否手工修正过字段 |
| `output_mode` | `varchar(16)` | not null, `'withStreet'` | — | 归一存储模式，读侧默认视图 |
| `confirmed_at` | `timestamptz` | nullable | `(owner_scope, confirmed_at desc)` | **用户确认时间**；null 表示尚未确认 |
| `created_at` / `updated_at` | `timestamptz` | not null, `now()` | — | 行时间戳 |

不给 `phone` 加唯一、不给 `detailed_address` 加等值去重索引；不对号码格式加 `check` 约束（掩码号码与分机也是合法输入）。

## Drizzle 表定义与写入映射

```typescript
import { sql } from "drizzle-orm";
import { boolean, check, index, jsonb, numeric, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import type { AddressCandidate, LevelNode, ParseResult } from "addr-parse-kit";

export const recipientAddress = pgTable(
  "recipient_address",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerScope: varchar("owner_scope", { length: 64 }).notNull(),
    ownerId: varchar("owner_id", { length: 64 }),
    recipientName: varchar("recipient_name", { length: 64 }),
    phone: varchar("phone", { length: 32 }),
    phoneExtension: varchar("phone_extension", { length: 16 }),
    maskedPhone: varchar("masked_phone", { length: 32 }),
    provinceCode: varchar("province_code", { length: 12 }).notNull(),
    provinceName: varchar("province_name", { length: 64 }).notNull(),
    cityCode: varchar("city_code", { length: 12 }),
    cityName: varchar("city_name", { length: 64 }),
    districtCode: varchar("district_code", { length: 12 }).notNull(),
    districtName: varchar("district_name", { length: 64 }).notNull(),
    streetCode: varchar("street_code", { length: 12 }),
    streetName: varchar("street_name", { length: 64 }),
    groupCode: varchar("group_code", { length: 12 }),
    groupName: varchar("group_name", { length: 64 }),
    streetMatchedText: varchar("street_matched_text", { length: 64 }),
    pathCodes: jsonb("path_codes").$type<readonly string[]>().notNull().default(sql`'[]'::jsonb`),
    pathNames: jsonb("path_names").$type<readonly string[]>().notNull().default(sql`'[]'::jsonb`),
    detailedAddress: text("detailed_address").notNull(),
    residualText: text("residual_text"),
    regionSource: varchar("region_source", { length: 64 }).notNull(),
    regionDatasetId: varchar("region_dataset_id", { length: 64 }).notNull(),
    regionVersion: varchar("region_version", { length: 64 }).notNull(),
    codeScheme: varchar("code_scheme", { length: 64 }).notNull(),
    parserVersion: varchar("parser_version", { length: 32 }).notNull(),
    sdkVersion: varchar("sdk_version", { length: 32 }).notNull(),
    candidateId: varchar("candidate_id", { length: 64 }),
    parseStatus: varchar("parse_status", { length: 16 }).notNull(),
    parseConfidence: numeric("parse_confidence", { precision: 5, scale: 4 }),
    parseWarnings: jsonb("parse_warnings").$type<readonly string[]>().notNull().default(sql`'[]'::jsonb`),
    requiresReview: boolean("requires_review").notNull().default(true),
    manualEdits: boolean("manual_edits").notNull().default(false),
    outputMode: varchar("output_mode", { length: 16 }).notNull().default("withStreet"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true, mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (table) => [
    index("recipient_address_owner_confirmed").on(table.ownerScope, table.confirmedAt),
    index("recipient_address_owner").on(table.ownerScope, table.ownerId),
    index("recipient_address_district").on(table.districtCode),
    index("recipient_address_street").on(table.streetCode),
    index("recipient_address_region").on(table.regionDatasetId, table.regionVersion),
    index("recipient_address_review").on(table.requiresReview).where(sql`${table.requiresReview} = true`),
    check(
      "recipient_address_status",
      sql`${table.parseStatus} in ('matched','ambiguous','partial','unmatched')`,
    ),
    check("recipient_address_detail_length", sql`char_length(${table.detailedAddress}) <= 512`),
  ],
);

export type RecipientAddressRow = typeof recipientAddress.$inferSelect;
export type NewRecipientAddress = typeof recipientAddress.$inferInsert;

function selection(node: LevelNode | null): LevelNode | null {
  return node && node.match !== "none" ? node : null;
}

/**
 * 候选 → 行。写入前宿主必须已完成：区域路径校验（parser.validateSelection + provider.validatePath）
 * 以及用户对非空字段的覆盖确认；本函数只做结构映射，不做任何猜测。
 */
export function toAddressRow(
  result: ParseResult,
  candidate: AddressCandidate,
  owner: { scope: string; id?: string },
  confirmed: boolean,
): NewRecipientAddress {
  const province = selection(candidate.province);
  const district = selection(candidate.district);
  if (!province || !district) {
    throw new Error("缺少省/区级确认结果，拒绝落库（不猜测层级）");
  }
  const city = selection(candidate.city);
  const street = selection(candidate.street);
  const group = selection(candidate.regionGroup);
  const chosen = [province, city, group, district, street].filter((node): node is LevelNode => node !== null);
  const row: NewRecipientAddress = {
    ownerScope: owner.scope,
    ownerId: owner.id ?? null,
    recipientName: candidate.recipient?.name ?? null,
    phone: candidate.recipient?.phone ?? null,
    phoneExtension: candidate.recipient?.phoneExtension ?? null,
    maskedPhone: candidate.recipient?.maskedPhone ?? null,
    provinceCode: province.code,
    provinceName: province.name,
    cityCode: city?.code ?? null,
    cityName: city?.name ?? null,
    districtCode: district.code,
    districtName: district.name,
    streetCode: street?.code ?? null,
    streetName: street?.name ?? null,
    groupCode: group?.code ?? null,
    groupName: group?.name ?? null,
    streetMatchedText: street?.matchedText ?? null,
    pathCodes: chosen.map((node) => node.code),
    pathNames: chosen.map((node) => node.name),
    detailedAddress: candidate.detailedAddress,
    residualText: candidate.residualText || null,
    regionSource: result.meta.regionSource,
    regionDatasetId: result.meta.datasetId,
    regionVersion: result.meta.regionVersion,
    codeScheme: result.meta.codeScheme,
    parserVersion: result.meta.parserVersion,
    sdkVersion: result.meta.sdkVersion,
    candidateId: candidate.candidateId,
    parseStatus: candidate.status,
    parseConfidence: candidate.confidence.toFixed(4),
    parseWarnings: candidate.warnings.map((warning) => warning.code),
    requiresReview: candidate.requiresReview,
    manualEdits: false,
    outputMode: "withStreet",
  };
  // 只有用户确认后才写 confirmedAt；解析成功本身不等于确认。
  if (confirmed) row.confirmedAt = new Date().toISOString();
  return row;
}
```

## 读侧：`withoutStreet` 只是视图

```typescript
import { formatAddress, formatRecipientLine, toWithoutStreet } from "addr-parse-kit";
import type { AddressCandidate } from "addr-parse-kit";

export function render(candidate: AddressCandidate, omitStreet: boolean): string[] {
  const view = omitStreet ? toWithoutStreet(candidate) : candidate;
  return [formatAddress(view), formatRecipientLine(view)];
}
```

同一行既能输出带街道的四级地址，也能输出把街道文本并回详细地址的 `withoutStreet` 形式；
库里的归一结构不变，折叠时优先用 `streetMatchedText`（原文里真实出现过的街道文本）而不是名称快照。

## 迁移与运维边界

- 迁移文件、执行时机与回滚脚本归宿主；本包不内置迁移、不自动建表，**也不在本仓库执行生产迁移**。
- 区域数据升级只新增数据集版本，不 `UPDATE` 历史名称列；历史行永远按自己记录的 `regionDatasetId/regionVersion` 解释。
- 复核队列按 `requires_review = true and confirmed_at is null` 建部分索引查询，不要用 `parse_confidence` 阈值替代人工确认。
- `parse_*` 列只服务于分析与复核排期，不得作为“地址真实存在/可配送”的证明。
- 日志与埋点默认不记录收件原文、姓名、号码；`ParseResult.input` 含原文，宿主自行决定是否留存，且不得写入 URL 查询参数。
