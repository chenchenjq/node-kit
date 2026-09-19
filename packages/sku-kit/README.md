# sku-kit

`sku-kit` is a private, server-authoritative package for sales specifications and SKU configuration. It owns stable specification identities, selected combinations, SKU codes, lifecycle, optimistic versions, and the consumer selection graph. The host owns SPUs, sale-price calculation, publication, orders, authorization source, file storage, and external inventory integration.

Each deployment selects exactly one SKU write authority: use `createPostgresSkuStore` with the supplied migration, or implement `SkuStore` over existing host tables. Do not write both models.

## Entrypoints

- `sku-kit`: browser-safe pure rules and shared types.
- `sku-kit/server`: application service and Store contract; server only.
- `sku-kit/postgres`: Drizzle schema and normalized PostgreSQL Store; server only.
- `sku-kit/client`: consumer-safe DTO types.
- `sku-kit/react`: controlled React selector/editor primitives.
- `sku-kit/testing`: in-memory Store for unit tests; server only.

## Server setup

Execute `migrations/0001-sku-kit.sql` through the host migration process, then pass a host-owned `pg.Pool`. The package never runs migrations automatically.

```ts
import { Pool } from "pg";
import { createPostgresSkuStore } from "sku-kit/postgres";
import { createSkuService } from "sku-kit/server";

const store = createPostgresSkuStore(new Pool({ connectionString: process.env.DATABASE_URL }));
const sku = createSkuService({
  store,
  resolveScope: async (request) => request.tenantId,
  authorize: async (request, action, { spuId }) => request.can(action, spuId) ? { ok: true } : { ok: false },
  projectConsumer: async (skus) => skus.map((item) => ({
    skuId: item.id, visible: true, selectable: true, salePrice: null, availability: "unknown",
  })),
});
```

`saveConfiguration` is idempotent by `commandId`; it freezes the first accepted SPU code and allocates `<SPU code>00` through `<SPU code>99` without reuse. Call `previewConfiguration` before saving when presenting a draft: it is read-only and returns added, retained, archivable, and restorable combinations. Restoring an archived combination requires its explicit historical SKU ID in `restoreArchivedSkuIds`.

## Boundary notes

Consumer results deliberately do not contain supply price. A host projection supplies the actual sale price, visibility, selectability, and availability. Multi-specification products begin with no selection; only a complete exact combination yields a SKU ID. For local inventory, use the independent compare-and-set `setLocalInventory`; it rejects scopes configured with an external inventory authority. The package has no reservation, deduction, or order workflow.

See [DATABASE.md](./DATABASE.md) for schema ownership and [AI-USAGE.md](./AI-USAGE.md) for integration constraints.
