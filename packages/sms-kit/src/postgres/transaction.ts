import type { PoolClient } from "pg";

import type { SmsTransaction } from "../ports/store.js";

/** PostgreSQL-specific transaction capability for adapters sharing a pg client. */
export interface PgSmsTransaction extends SmsTransaction {
  readonly client: PoolClient;
}

export function asSmsTransaction(client: PoolClient): PgSmsTransaction {
  return Object.freeze({ client }) as PgSmsTransaction;
}
