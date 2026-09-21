import { Pool } from "pg";
import { createPostgresSkuStoreForTransaction } from "sku-kit/postgres";
import { createSkuService } from "sku-kit/server";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Reference only: the host must replace tenant and permission resolution.
export async function POST(request: Request) {
  const body = await request.json();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Host SPU validation/locking belongs here, before the SKU transaction lock.
    const service = createSkuService({
      store: createPostgresSkuStoreForTransaction(client),
      resolveScope: async () => String(body.scopeKey),
      authorize: async () => ({ ok: true }),
    });
    const result = await service.saveConfiguration({}, body.input);
    if (!result.ok) { await client.query("ROLLBACK"); return Response.json(result, { status: 400 }); }
    await client.query("COMMIT");
    return Response.json(result);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
