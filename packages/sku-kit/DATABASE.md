# Database integration

Apply `migrations/0001-sku-kit.sql` explicitly in the host's selected PostgreSQL schema. The migration creates scope configuration, product configuration, dimensions, values, SKU identities, selected value relations, local inventory, and expiring command receipts. It does not create SPU, order, file, or external-inventory tables.

`createPostgresSkuStore(pool, { schemaName })` expects those tables already to exist. Every write starts one database transaction, takes a transaction-scoped advisory lock for the trusted `(scopeKey, spuId)`, locks the product row when it exists, and writes the normalized document atomically. For a host-owned transaction, use `createPostgresSkuStoreForTransaction(client, { schemaName })`: it never begins, commits, rolls back, or releases the client. If a host also creates its SPU in the transaction, take the host SPU lock first and invoke the SKU write second.

The migration preserves archived identities. It deliberately has no ordinary delete API. PostgreSQL is the only persistence authority when this Store is selected; an existing host Store is an alternative authority, never a second write target.

The default migration uses `public`. For another schema, execute an equivalent reviewed migration there and supply the exact schema name to the adapter. Schema names are validated as PostgreSQL identifiers and never interpolated from requests.
