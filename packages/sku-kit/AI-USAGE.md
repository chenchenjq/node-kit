# AI usage constraints

When changing this package, retain these invariants:

- Stable dimension/value IDs, canonical combination keys, SKU IDs, codes, and sequences are history. Rename edits labels; removal archives; restoration is explicit.
- Reads and previews never allocate IDs/codes or persist data. New formal IDs are returned only from a successful save.
- Keep management, consumer, and historical contracts separate. Consumer types must never expose supply price.
- The host remains authoritative for SPU ownership, authorization, actual sale price, publication, file URLs, orders, and external inventory semantics.
- Do not add reserve, deduct, refund, automatic stock migration, or dual-write reconciliation behavior.
- Use a single SKU Store and one inventory authority per scope. Test concurrency-sensitive writes through the Store seam.

Run `npm run typecheck --workspace sku-kit`, `npm test --workspace sku-kit`, and `npm run build --workspace sku-kit` before handoff. The migration must be reviewed and applied by the host; package code must not execute it automatically.
