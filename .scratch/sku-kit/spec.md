# sku-kit — 可复用销售规格与 SKU 配置

Status: ready-for-agent

## Problem Statement

多个宿主系统需要在新增或编辑商品时配置销售规格与 SKU，并在商品展示时提供正确的规格选择能力。当前仓库没有可复用的 SKU 领域包，也没有可供直接接入的宿主商品中心；若每个系统各自实现，容易出现按数组位置编号、删除重建 SKU、库存双写、供应价泄露、规格改名改变历史身份、并发重复分配编码等问题。

用户需要一个私有 Node.js 包：它能独立提供严谨的销售规格与 SKU 配置能力，也能在宿主已经拥有 SKU 数据时通过受约束的 Store 接口接入；它不能顺势扩张为 SPU 商品中心、价格引擎、库存中心、订单系统或完整电商平台。

## Solution

构建 `sku-kit`，把销售规格、组合身份、SKU 生命周期、编号、配置版本和选择图规则集中到一个应用服务中。包提供浏览器安全的纯规则、授权服务端能力、真实 PostgreSQL/Drizzle Store、库存与消费者投影端口、受控 React 编辑器和选择器、Store 契约测试以及 Next.js 参考宿主。

每次部署只允许一个 SKU 写权威；每个作用域只允许一个库存权威。宿主继续拥有 SPU、发布状态、实际售价、交易、履约、权限来源和文件存储。默认 PostgreSQL Store 可以直接运行，已有 SKU 系统也可以实现同一低级 Store 契约继续作为唯一权威，禁止双写。

设计以稳定身份和历史可解释性为中心：组合由稳定维度和值 ID 决定，SKU 编码一经分配永不改写或复用，读取与预览不产生写入，模式转换不自动搬运库存，消费者 DTO 从类型层面排除供应价。

## User Stories

1. As a 宿主系统开发者, I want to install one private SKU package, so that multiple systems can reuse the same SKU rules.
2. As a 宿主架构师, I want the package to reference rather than own SPUs, so that the existing product center remains authoritative.
3. As a 宿主架构师, I want to choose exactly one SKU Write Authority per deployment, so that no dual-write reconciliation is required.
4. As a legacy-system integrator, I want to implement the Store contract over existing SKU tables, so that migration into a second writable model is optional.
5. As a platform operator, I want every product reference scoped by a trusted Scope and SPU ID, so that systems sharing a database remain isolated.
6. As a security engineer, I want Scope to be derived on the trusted server, so that a browser cannot switch tenant or storefront ownership.
7. As a single-tenant integrator, I want to use a fixed non-empty Scope, so that future multi-system sharing does not require redefining identity.
8. As a product administrator, I want to save a product with no custom sales specifications, so that it receives one Default SKU.
9. As a product administrator, I want a real one-combination product to retain its real specification labels, so that it is not mislabeled as “default”.
10. As a product administrator, I want opening an editor to create only a Configuration Draft, so that previewing does not consume an SKU code.
11. As a product administrator, I want repeated first-save commands to be idempotent, so that retries do not create duplicate Default SKUs.
12. As a product administrator, I want a first multi-specification save to allocate real combinations from sequence 00, so that no unused Default SKU consumes capacity.
13. As an operations user, I want SKU codes derived from the frozen Registered SPU Code and 00–99 suffixes, so that codes follow the business convention.
14. As an auditor, I want sequence 99 to be allocatable and the 101st historical identity to fail clearly, so that the 100-code lifetime limit is unambiguous.
15. As an auditor, I want archived sequences never to be reused, so that historical and external references cannot acquire a new meaning.
16. As a host integrator, I want a changed host SPU code to be rejected on later SKU writes, so that existing SKU codes are not silently rewritten.
17. As a product administrator, I want to define custom Sales Specification Dimensions and Values, so that the editor supports the product’s actual choices.
18. As a product administrator, I want dimensions and values to have stable IDs, so that labels and array order do not define identity.
19. As a product administrator, I want duplicate labels detected after Unicode, whitespace, and case normalization, so that visually equivalent choices cannot coexist accidentally.
20. As a product administrator, I want `500g` and `0.5kg` treated as distinct values, so that the package does not invent unit conversions.
21. As a product administrator, I want Rename to preserve identity, so that a spelling correction does not create new SKUs.
22. As a product administrator, I want Replace to create a new identity, so that a semantic change does not rewrite history.
23. As a product administrator, I want archived dimensions and values restored only by explicit ID, so that matching text cannot silently revive an old identity.
24. As a product administrator, I want built-in and host Presets copied into the current draft, so that common configurations are quick to create without cross-product identity coupling.
25. As a product administrator, I want a combination preview before saving, so that I can see retained, added, removed, and restorable combinations.
26. As a product administrator, I want potential combinations counted before materialization, so that a large Cartesian product is rejected safely.
27. As a product administrator, I want to choose only the combinations actually sold, so that every Cartesian-product row does not have to become an active SKU.
28. As a platform owner, I want hard limits of five active dimensions and one hundred potential/active combinations, so that the first version stays operationally bounded.
29. As a product administrator, I want unchanged combinations to retain SKU ID, code, price, image, state, and inventory association, so that edits are incremental.
30. As a product administrator, I want a new SKU to start Disabled with null prices and image, so that incomplete data is not exposed as sellable.
31. As a product administrator, I want omitted, null, and provided patch fields to have different meanings, so that saving one field does not clear another.
32. As a product administrator, I want a batch fill operation to populate only empty values by default, so that existing work is preserved.
33. As a product administrator, I want overwrite to require an explicit mode and confirmation, so that bulk edits cannot silently destroy configured values.
34. As a pricing administrator, I want Suggested Retail Price and Supply Price stored independently as exact CNY decimals, so that cost and recommendation semantics remain distinct.
35. As a pricing administrator, I want null and explicit zero prices distinguished, so that “not configured” is not reported as free.
36. As a pricing administrator, I want a supply-above-retail condition reported as a warning rather than rejected, so that exceptional business cases remain possible.
37. As a security administrator, I want Supply Price protected by separate authorization, so that ordinary SKU editors cannot necessarily read or change cost data.
38. As a shopper, I want only host-projected Sale Price displayed, so that a recommendation or supply cost is never presented as the checkout price.
39. As an inventory administrator, I want one Inventory Authority per Scope, so that local and external stock are not silently mixed.
40. As an inventory administrator, I want local, external read-write, and external read-only capabilities represented explicitly, so that the UI cannot offer unsupported writes.
41. As an inventory administrator, I want absolute quantity updates guarded by expected versions, so that stale edits do not overwrite newer stock.
42. As an inventory administrator, I want missing external inventory reported as Unknown Inventory, so that it is not mistaken for zero or in-stock.
43. As an inventory administrator, I want normal SKU configuration saves to exclude inventory, so that changing a price or image cannot overwrite live stock.
44. As an inventory-system owner, I want the package to omit reservation, deduction, refund, and synchronization workflows, so that it does not pretend to be an order-safe inventory center.
45. As a media integrator, I want an SKU Image Reference to be stable and adapter-resolved, so that temporary signed URLs are not stored.
46. As a media integrator, I want image replacement or SKU archival not to delete files, so that shared objects remain safe.
47. As a product administrator, I want removing a persisted combination to archive rather than delete it, so that historical identity remains readable.
48. As a product administrator, I want an archived combination to require explicit restoration, so that reintroducing matching values cannot create or revive an identity silently.
49. As a product administrator, I want Default-to-multi and multi-to-Default changes previewed, so that their impact is visible before saving.
50. As an inventory administrator, I want mode changes blocked until stock and external mappings are handled, so that conversion cannot silently lose inventory meaning.
51. As a product administrator, I want mode changes never to copy, split, average, or sum inventory, so that the package does not invent migration policy.
52. As a product administrator, I want price and image copying to name the source, targets, fields, and mode, so that every copied value is intentional.
53. As a concurrent editor, I want structure and per-SKU configuration to use separate versions, so that unrelated updates conflict only when necessary.
54. As an inventory editor, I want Inventory Version independent from SKU configuration versions, so that price edits do not invalidate stock writes.
55. As an API client, I want command IDs to make retries safe for a defined window, so that network retries do not duplicate writes.
56. As a host database integrator, I want to bind SKU writes to an existing PostgreSQL transaction, so that SPU and SKU creation can commit atomically.
57. As a host database integrator, I want explicit lock ordering, so that host and package writes do not introduce avoidable deadlocks.
58. As a host database integrator, I want failed transactions to roll back sequence allocation, so that failed attempts do not consume codes.
59. As a custom Store author, I want a conformance suite, so that my implementation can prove equivalent locking, history, version, and idempotency behavior.
60. As a management user, I want a Management View containing authorized configuration and history, so that I can operate the SKU model.
61. As a shopper, I want a Consumer View that cannot contain Supply Price, so that sensitive fields cannot leak through frontend filtering mistakes.
62. As a support user, I want a Historical Read View for archived SKUs, so that old references remain explainable without impersonating order snapshots.
63. As a shopper, I want partial specification choices to filter the next valid values, so that impossible paths are clear.
64. As a shopper, I want nonexistent combinations, host-disabled choices, out-of-stock choices, and unknown availability distinguished, so that the interface communicates the real reason.
65. As a shopper, I want no specification value auto-selected on multi-spec products, so that the interface does not silently choose the first or cheapest SKU.
66. As a shopper, I want only a complete exact selection to produce a selected SKU, so that incomplete choices cannot be submitted as an order line.
67. As a shopper, I want the Default SKU resolved directly for a product with no custom specifications, so that a pointless selector is unnecessary.
68. As a shopper, I want an exact SKU image after complete selection and the SPU image otherwise, so that imagery follows an explicit selection.
69. As a shopper, I want complete, partial, and unknown Sale Price ranges distinguished, so that missing prices are not treated as zero.
70. As an order-service developer, I want the browser to submit only SKU ID and selections, so that the server can revalidate ownership, publication, actual price, and inventory.
71. As an order-service developer, I want orders to retain SKU ID, code, specification names, and transaction amount snapshots, so that later SKU edits do not rewrite historical sales.
72. As a permissions administrator, I want consumer read, management read, cost, structure, configuration, lifecycle, inventory, and history actions authorized separately, so that least privilege is possible.
73. As a frontend integrator, I want a controlled SKU editor component, so that my host owns networking, authentication, upload, and confirmation UX.
74. As a frontend integrator, I want a controlled SKU selector component, so that I can embed selection behavior without importing server dependencies.
75. As a keyboard or assistive-technology user, I want accessible labels, states, errors, and focus handling, so that SKU management and selection are operable without a pointer.
76. As a Node.js consumer, I want browser-safe and server-only package entry points, so that database and authorization code cannot enter a client bundle.
77. As a Next.js integrator, I want a runnable reference host rather than a framework dependency, so that I can copy the integration pattern without coupling the core package to Next.js.
78. As a release engineer, I want an npm tarball tested in a clean external host, so that workspace links cannot hide missing files or dependencies.
79. As an AI coding agent, I want accurate public exports, defaults, error codes, and integration constraints documented after implementation, so that generated host code uses only supported APIs.
80. As a maintainer, I want real-host migration and live integrations marked as requiring information, so that reference fakes are never reported as production validation.

## Implementation Decisions

- The package owns sales-specification and SKU-configuration rules only. SPU ownership, publication, Sale Price, orders, fulfillment, authorization source, and file storage remain host responsibilities.
- One deployment has exactly one SKU Write Authority. The package supplies a default PostgreSQL implementation; an existing host may instead implement the same Store contract. Dual writes are prohibited.
- One Scope has exactly one Inventory Authority, persisted with a stable authority key and fixed CNY currency. A changed authority is rejected until an explicit host-managed migration and rebind occurs.
- Scope is mandatory even in single-tenant deployments and is combined with SPU ID for host-product identity. Scope is resolved by trusted server context and never accepted from browser DTOs.
- The application service owns numbering, combination, lifecycle, version, authorization, and scope invariants. Store implementations expose low-level transactional locking/read/write capabilities and must pass the conformance suite.
- The package exposes browser-safe core, authorized server, PostgreSQL, browser client-contract, controlled React, and server-only testing entry points. Server/PostgreSQL/testing imports must fail in browser builds. The core has no Next.js dependency and no built-in HTTP router.
- Official PostgreSQL identities are UUIDs. Custom Stores may use other opaque stable strings, but IDs cannot be reused and display labels or order cannot become identity.
- Combination identity uses a versioned canonical JSON representation of stable dimension/value ID pairs sorted by dimension ID. The empty list identifies the Default SKU. Combination keys are server-generated and are not replaced by hashes.
- Registered SPU Code is frozen on first persistence, is case-sensitive, and remains unique within a Scope forever. It is 1–126 characters and rejects surrounding whitespace, controls, and newlines without other Unicode rewriting.
- SKU Code is Registered SPU Code plus a two-digit sequence from 00 through 99. Sequence 99 is valid; the next identity fails. IDs, codes, sequences, and combination identities are never recycled or rewritten.
- PostgreSQL allocation runs under a transaction-level Scope/SPU lock and locked product-configuration row at `READ COMMITTED`. First-row creation uses the same serialization boundary. Sequence advancement and SKU creation commit or roll back together.
- The PostgreSQL adapter supports package-owned transactions and caller-owned transaction binding. In caller-owned mode, only the host commits or rolls back. Lock order is host SPU first, then SKU Scope/SPU lock.
- A Configuration Draft has no formal IDs or codes. New client-side entities use request-local draft keys; saving generates formal identities and returns a complete mapping. Reads and previews never persist or allocate.
- First persistence of a no-specification target creates the Default SKU at the next sequence. First persistence of a multi-specification target creates only the selected real combinations.
- Dimension and value duplicate keys use Unicode NFKC, trimmed edges, collapsed internal whitespace, and Unicode lowercasing. Display text is retained. Units, synonyms, and simplified/traditional Chinese are not converted.
- Active configuration is limited to five dimensions, one hundred values per dimension, one hundred potential combinations, and one hundred selected active combinations. Hosts may configure smaller limits only. Historical sequence capacity is checked separately.
- Rename preserves identity and represents a display correction. Replace creates a new identity and represents a semantic change. Archived dimensions and values are restored only by explicit formal ID.
- Built-in presets contain the agreed color, size, dimension, and weight examples and can be disabled. Host presets are namespaced. Applying any preset copies data into the current draft and creates no lasting linkage.
- Configuration saving submits the complete intended active structure plus patches for changed SKU fields. The server recomputes the diff and never trusts a client-supplied diff or preview.
- Nullable patch fields are tri-state: omitted preserves, null clears, and a value sets. Inventory cannot appear in general configuration patches.
- New SKUs begin Disabled, with null Suggested Retail Price, Supply Price, and image, and configuration version 1. Local Inventory begins Known at zero with version 1; external inventory uses the authority response and may be Unknown.
- Persisted combination removal archives the SKU. A historical combination appearing again is reported as Restorable and requires an explicit original SKU ID; omission fails instead of creating or restoring silently.
- Persistent SKU states are Disabled, Enabled, and Archived. Enabled does not mean purchasable. Archived identities remain historically readable and can only be explicitly restored as the same identity.
- Enabled/Disabled changes affect configuration version. Archive/restore affects both structure version and configuration version. Inventory versions remain independent.
- Default/multi-specification conversions never migrate inventory automatically. A host precondition must approve stock and external mappings. Prices and images can be copied only through an explicit source/target/field/mode operation.
- Suggested Retail Price and Supply Price are nullable, non-negative CNY decimal values with at most sixteen integer digits and two fractional digits. Inputs reject exponent, sign, separators, and excess precision; outputs use two decimals. Null and zero differ.
- Supply Price exceeding Suggested Retail Price produces a warning rather than a blocking failure. Supply Price has separate read/write authorization and is absent from Consumer View types.
- Sale Price is supplied by a host projection. It is never inferred from Suggested Retail Price or Supply Price.
- Inventory supports batch read and versioned absolute setting only. Local read-write, external read-write, and external read-only capabilities are explicit. Increment, reserve, deduct, refund, multi-warehouse, and automatic synchronization are absent.
- External reads return Known quantity/version or Unknown with a safe reason. External write failures are explicit problems rather than Unknown results. General SKU saves never write inventory.
- SKU images store a stable adapter/value reference, never a temporary URL. A host resolver produces access links. Optional OSS mapping does not create a hard dependency, and the package never deletes files.
- Per-SKU batch copy defaults to empty-only. Overwrite is explicit and UI-confirmed. Inventory cannot be copied.
- Structure, SKU configuration, and inventory have separate optimistic versions. Batch configuration writes check the structure version and each changed SKU version, then commit or roll back as a unit.
- Each write has a command ID. For a default seven-day receipt window, identical retries return the prior safe result and a changed payload under the same ID conflicts. Receipt cleanup is explicit and never happens during reads.
- Expected domain outcomes return a discriminated result with stable problem code, safe message, retryability, and structured safe details. Programmer errors, Store violations, and infrastructure crashes throw sanitized exceptions.
- Stable problem codes cover validation, not found, forbidden, scope mismatch, SPU-code conflict/mismatch, version and idempotency conflict, combination conflict, capacity exhaustion, restore requirement, transition blocking, unknown/read-only inventory, and adapter failure.
- Management View, Consumer View, and Historical Read View are separate contracts. Historical reads explain archived SKU identity but do not impersonate order snapshots.
- Consumer projection receives safe candidate identity and Suggested Retail Price, never Supply Price. The host returns visibility, selectability, optional Sale Price, availability/reason, and safe display metadata before the package builds the Selection Graph.
- Archived SKUs are absent from Consumer View; Disabled SKUs are absent by default but visible in management preview. Missing projection data cannot be guessed as purchasable.
- Partial selection exposes only values that can still reach a candidate. Multi-specification products never auto-select a value. Only a complete exact match yields a selected SKU; no-specification products resolve the Default SKU.
- Before a complete selection, the host SPU image is used. After selection, the SKU image is preferred and safely falls back to the SPU image. Sale Price ranges are Complete, Partial, or Unknown and never substitute zero for missing prices.
- The database model contains Scope configuration, product configuration, dimension, value, SKU, SKU/value relation, local inventory, and command receipt data. Composite ownership constraints prevent cross-Scope or cross-SPU relationships.
- Database constraints enforce unique Registered SPU Code per Scope, unique SKU Code per Scope, unique sequence and combination per SPU, the Default identity, active normalized-name uniqueness, non-negative exact amounts, and retained archived identities.
- Migrations are explicit and reviewable, never auto-run, and do not assume or foreign-key a host SPU table. Hosts may add their own compatible foreign key in host migrations.
- The controlled editor covers specification editing, Rename/Replace, limits, combination selection, diff/mode preview, per-SKU configuration, bulk fill, loading/errors/conflicts, and unsaved state. Network, auth, upload, inventory, and confirmation behavior are injected.
- The controlled selector consumes Consumer View only, exposes selection and an SKU ID only after exact resolution, differentiates unavailable reasons, and provides keyboard and assistive-technology semantics.
- The reference host demonstrates trusted Scope/auth resolution, caller-owned SPU/SKU transaction, management and detail flows, and host projection without becoming a runtime dependency or a claimed production integration.
- The first verified baseline follows the repository’s current Node 22, TypeScript 7, Drizzle 0.45, pg 8.23, React 19, Next.js 16 example, Vitest 4, and PostgreSQL 18 setup. Only combinations actually run may be documented as supported.
- Public user documentation is generated from the finished implementation and consists of README, database reference, and AI usage guide. Domain glossary and ADRs remain internal engineering documentation.

## Testing Decisions

- The primary and highest test seam is the authorized application service. Tests issue complete public commands/queries with fake host context and assert returned results plus observable persisted state; they do not assert helper calls or private class structure.
- Pure-rule tests cover normalization, exact decimal validation, combination identity, preset copying, capacity checks, diff classification, restoration requirements, and Selection Graph behavior. These tests assert domain behavior rather than implementation algorithms.
- A reusable Store conformance seam runs the same transactional behavior suite against the default PostgreSQL Store and any host Store. It covers lock serialization, uniqueness, rollback, independent versions, historical retention, command receipts, and caller-owned transactions.
- Real PostgreSQL integration tests use the repository’s established Testcontainers pattern with a pinned PostgreSQL 18 image digest. Mocks do not substitute for database constraint, transaction, rollback, or concurrency evidence.
- Concurrency tests cover first initialization, simultaneous combination creation, duplicate command retries, sequence 99/100 behavior, failed transaction rollback, and the documented host-SPU-before-SKU lock order.
- Service tests cover every authorization action, trusted Scope resolution, cross-Scope and cross-SPU injection, SPU-code mismatch, stale structure/configuration versions, restoration preconditions, and sanitized failures.
- Price/configuration tests cover null versus zero, negative and excessive precision rejection, boundary amounts, independent SKU updates, supply-above-retail warnings, empty-only versus overwrite, and proof that configuration writes do not alter inventory.
- Inventory tests cover local Known zero initialization, absolute compare-and-set, external Known/Unknown results, external read-only rejection, explicit write failure, authority-key mismatch, and proof that no order-reservation behavior exists.
- Consumer tests serialize real Consumer Views and prove that Supply Price is structurally absent. They cover Disabled/Archived filtering, partial selections, exact matches, distinct unavailability reasons, image fallback, and Complete/Partial/Unknown Sale Price ranges.
- React tests use the repository’s established Testing Library/user-event style and assert controlled updates, labels, fieldset/radio or equivalent semantics, keyboard operation, error association, focus recovery, unsaved state, and absence of implicit first-SKU selection.
- Browser-boundary tests prove that importing server, PostgreSQL, or testing entry points into a client build fails, while browser-safe types, client contracts, and React components build without pg or Drizzle.
- Packaging tests follow the repository’s existing clean-consumer seam: build, create an npm tarball, inspect its contents, install it outside the workspace into clean Node and Next.js hosts, then exercise types, migrations, PostgreSQL, management, and consumer flows.
- Documentation examples are typechecked against the packed public exports. Supported-version and verification claims are generated only from commands actually run.
- Security fixtures are synthetic. Tests prove that logs and problem details do not expose Supply Price without authorization, tokens, connection strings, SQL, complete image references, or host personal data.
- A good test fails only when externally promised behavior changes. Private helper names, internal query counts, exact SQL formatting, and React implementation structure are not test contracts unless required by a published boundary.
- Prior art is the repository’s existing package pattern: strict TypeScript/Vitest units, Testcontainers PostgreSQL integration, browser-forbidden export verification, React Testing Library interaction tests, and npm-pack clean-host checks.

## Out of Scope

- Owning or rebuilding the host SPU/product center.
- Product categories, rich specification-template administration, barcode systems, supplier mappings, tier pricing, promotions, or channel synchronization.
- Calculating transaction price or treating Suggested Retail Price as Sale Price.
- Order placement, oversell protection, reservation, deduction, refund rollback, multi-warehouse, weighing transactions, or automatic inventory synchronization.
- Uploading or deleting files, owning OSS credentials, or assuming an SKU image is an exclusive object.
- Rewriting historical orders or reconstructing transaction history from current SKU labels.
- Automatic inventory migration during Default/multi-specification conversion.
- Physical deletion of SKU, dimension, value, or Scope data through ordinary business APIs.
- A standalone HTTP service, task platform, full product-management application, or mandatory Next.js runtime.
- A generic importer for unknown legacy schemas, dual-write bridge, or claimed production migration without a real host.
- Live external inventory, upload, and production-migration validation until the host contracts and environment are supplied.
- Multi-currency support in the first data-model version.

## Further Notes

- The repository currently contains no commerce host implementation. The default Store, reference host, automated verification, and package documentation are ready for agent implementation; the separate real-host integration task remains `needs-info`.
- The agreed testing seam was confirmed during the preceding design interview: application-service behavior is primary, with Store conformance, real PostgreSQL, React accessibility, browser isolation, and packed clean-host verification as boundary-specific seams.
- Internal domain language and architectural decisions have already been recorded and should be treated as constraints rather than reopened implicitly during implementation.
- Existing workspace changes belong to the user and must be preserved. Implementation must not push, publish, run production migrations, or overwrite unrelated work.
- Public README/database/AI usage documentation must wait for real exports and executed verification. Reference fakes must remain clearly labeled and cannot be reported as live integrations.

## Comments

- Synthesized from the completed design interview and published with `ready-for-agent` status using the project’s local Markdown issue tracker.
