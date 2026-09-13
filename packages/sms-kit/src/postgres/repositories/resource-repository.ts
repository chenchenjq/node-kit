import type { Pool, PoolClient } from "pg";

import { SmsKitError } from "../../core/errors.js";
import type {
  ResourceRepository, ResourceSyncCandidate, ResourceSyncPreview, Signature, SmsTransaction, Template,
} from "../../ports/store.js";
import type { PgSmsTransaction } from "../transaction.js";

type Queryable = Pool | PoolClient;
type CandidateRow = {
  id: string; resource_type: "signature" | "template"; external_key: string;
  change_type: ResourceSyncCandidate["changeType"]; checksum: string; snapshot: unknown;
};

function queryable(pool: Pool, tx?: SmsTransaction): Queryable {
  return tx === undefined ? pool : (tx as PgSmsTransaction).client;
}

async function transaction<T>(pool: Pool, tx: SmsTransaction | undefined, work: (client: Queryable) => Promise<T>): Promise<T> {
  if (tx !== undefined) return work(queryable(pool, tx));
  const client = await pool.connect();
  try {
    await client.query("begin");
    const value = await work(client);
    await client.query("commit");
    return value;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

function signature(row: { id: string; external_key: string; external_name: string; external_status: string; external_type: string; enabled: boolean; version: string }): Signature {
  return { id: row.id, externalKey: row.external_key, externalName: row.external_name, externalStatus: row.external_status, externalType: row.external_type, enabled: row.enabled, version: Number(row.version) };
}

function template(row: { id: string; signature_id: string; template_key: string; external_code: string; external_name: string; external_status: string; template_type: "verification" | "notification"; purpose: string; variable_schema: unknown; enabled: boolean; version: string }): Template {
  const names = Array.isArray(row.variable_schema) ? row.variable_schema.filter((name): name is string => typeof name === "string") : [];
  return { id: row.id as Template["id"], signatureId: row.signature_id, templateKey: row.template_key, externalCode: row.external_code, externalName: row.external_name, externalStatus: row.external_status, templateType: row.template_type, purpose: row.purpose, variables: names.map((name) => ({ name, sensitive: false })), enabled: row.enabled, version: Number(row.version) };
}

function safeSnapshot(candidate: ResourceSyncCandidate): object {
  if (candidate.resourceType === "signature") {
    return { kind: "signature", externalName: candidate.snapshot.externalName, externalStatus: candidate.snapshot.externalStatus, externalType: candidate.snapshot.externalType };
  }
  return { kind: "template", externalCode: candidate.snapshot.externalCode, externalName: candidate.snapshot.externalName, externalStatus: candidate.snapshot.externalStatus, templateType: candidate.snapshot.templateType, variableNames: [...candidate.snapshot.variableNames], signatureExternalKey: candidate.signatureExternalKey, templateKey: candidate.templateKey, purpose: candidate.purpose };
}

function isCloudApproved(status: string): boolean {
  return status.toLowerCase() === "approved" || status.toUpperCase() === "AUDIT_STATE_PASS";
}

export class PgResourceRepository implements ResourceRepository {
  constructor(private readonly pool: Pool) {}

  async listSignatures(input: Readonly<{ page: number; pageSize: number }>, tx?: SmsTransaction): Promise<{ items: readonly Signature[]; total: number }> {
    const db = queryable(this.pool, tx);
    const [items, count] = await Promise.all([
      db.query("select id, external_key, external_name, external_status, external_type, enabled, version from sms_kit.signature order by external_name, id limit $1 offset $2", [input.pageSize, (input.page - 1) * input.pageSize]),
      db.query<{ total: string }>("select count(*)::text as total from sms_kit.signature"),
    ]);
    return { items: items.rows.map(signature), total: Number(count.rows[0]?.total ?? "0") };
  }

  async listTemplates(input: Readonly<{ page: number; pageSize: number }>, tx?: SmsTransaction): Promise<{ items: readonly Template[]; total: number }> {
    const db = queryable(this.pool, tx);
    const [items, count] = await Promise.all([
      db.query("select id, signature_id, template_key, external_code, external_name, external_status, template_type, purpose, variable_schema, enabled, version from sms_kit.template order by template_key limit $1 offset $2", [input.pageSize, (input.page - 1) * input.pageSize]),
      db.query<{ total: string }>("select count(*)::text as total from sms_kit.template"),
    ]);
    return { items: items.rows.map(template), total: Number(count.rows[0]?.total ?? "0") };
  }

  async findTemplateByKey(input: Readonly<{ templateKey: string }>, tx?: SmsTransaction): Promise<Template | undefined> {
    const { rows } = await queryable(this.pool, tx).query("select id, signature_id, template_key, external_code, external_name, external_status, template_type, purpose, variable_schema, enabled, version from sms_kit.template where template_key = $1", [input.templateKey]);
    return rows[0] === undefined ? undefined : template(rows[0]);
  }

  async createSyncPreview(input: Readonly<{ id: string; actorId: string; expiresAt: Date; resources: readonly ResourceSyncCandidate[] }>, tx?: SmsTransaction): Promise<ResourceSyncPreview> {
    return transaction(this.pool, tx, async (db) => {
      await db.query("insert into sms_kit.resource_sync (id, actor_id, status, summary, expires_at, started_at) values ($1, $2, 'running', '{}'::jsonb, $3, now())", [input.id, input.actorId, input.expiresAt]);
      for (const candidate of input.resources) {
        await db.query(
          "insert into sms_kit.resource_sync_candidate (id, sync_id, resource_type, external_key, change_type, snapshot, checksum, expires_at, created_at) values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, now())",
          [candidate.id, input.id, candidate.resourceType, candidate.externalKey, candidate.changeType, JSON.stringify(safeSnapshot(candidate)), candidate.checksum, input.expiresAt],
        );
      }
      return { id: input.id, status: "running", expiresAt: input.expiresAt, candidates: input.resources };
    });
  }

  async commitSync(input: Readonly<{ syncId: string; candidates: readonly Readonly<{ id: string; checksum: string }>[]; now?: Date }>, tx?: SmsTransaction): Promise<ResourceSyncPreview> {
    return transaction(this.pool, tx, async (db) => {
      const sync = await db.query<{ expires_at: Date; status: ResourceSyncPreview["status"] }>("select expires_at, status from sms_kit.resource_sync where id = $1 for update", [input.syncId]);
      if (sync.rows[0] === undefined || sync.rows[0].status !== "running" || sync.rows[0].expires_at <= (input.now ?? new Date())) throw new SmsKitError("CONCURRENT_MODIFICATION", "resource preview is no longer current");
      const ids = input.candidates.map((candidate) => candidate.id);
      const candidates = ids.length === 0 ? [] : (await db.query<CandidateRow>("select id, resource_type, external_key, change_type, checksum, snapshot from sms_kit.resource_sync_candidate where sync_id = $1 and id = any($2::uuid[]) order by case resource_type when 'signature' then 0 else 1 end, id for update", [input.syncId, ids])).rows;
      if (candidates.length !== input.candidates.length || candidates.some((candidate) => input.candidates.find((chosen) => chosen.id === candidate.id)?.checksum !== candidate.checksum)) {
        throw new SmsKitError("CONCURRENT_MODIFICATION", "resource preview checksum changed");
      }
      for (const candidate of candidates) {
        if (candidate.resource_type === "signature") {
          const snapshot = candidate.snapshot as Extract<ResourceSyncCandidate, { resourceType: "signature" }>["snapshot"];
          if (candidate.change_type === "unavailable") {
            await db.query(
              "update sms_kit.signature set external_status = 'unavailable', enabled = false, last_synced_at = now(), version = version + 1, updated_at = now() where external_key = $1",
              [candidate.external_key],
            );
            await db.query("update sms_kit.resource_sync_candidate set committed_at = now() where id = $1", [candidate.id]);
            continue;
          }
          if (!isCloudApproved(snapshot.externalStatus)) {
            throw new SmsKitError("CONFIG_INVALID", "resource is not cloud-approved");
          }
          await db.query(
            `insert into sms_kit.signature (id, external_key, external_name, external_status, external_type, imported_at, last_synced_at, created_at, updated_at)
             values ($1, $2, $3, $4, $5, now(), now(), now(), now())
             on conflict (external_key) do update set external_name = excluded.external_name, external_status = excluded.external_status,
               external_type = excluded.external_type, last_synced_at = now(), version = sms_kit.signature.version + 1, updated_at = now()`,
            [candidate.id, candidate.external_key, snapshot.externalName, snapshot.externalStatus, snapshot.externalType],
          );
        } else {
          const snapshot = candidate.snapshot as Extract<ResourceSyncCandidate, { resourceType: "template" }>["snapshot"] & { signatureExternalKey: string; templateKey: string; purpose: string };
          if (candidate.change_type === "unavailable") {
            await db.query(
              "update sms_kit.template set external_status = 'unavailable', enabled = false, last_synced_at = now(), version = version + 1, updated_at = now() where external_code = $1",
              [snapshot.externalCode],
            );
            await db.query("update sms_kit.resource_sync_candidate set committed_at = now() where id = $1", [candidate.id]);
            continue;
          }
          if (!isCloudApproved(snapshot.externalStatus)) {
            throw new SmsKitError("CONFIG_INVALID", "resource is not cloud-approved");
          }
          const signature = await db.query<{ id: string }>("select id from sms_kit.signature where external_key = $1", [snapshot.signatureExternalKey]);
          if (signature.rows[0] === undefined) throw new SmsKitError("CONFIG_INVALID", "template preview has no matching signature");
          await db.query(
            `insert into sms_kit.template (id, signature_id, template_key, external_code, external_name, external_status, template_type, purpose, content_snapshot, variable_schema, imported_at, last_synced_at, created_at, updated_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, '', $9::jsonb, now(), now(), now(), now())
             on conflict (external_code) do update set signature_id = excluded.signature_id, external_name = excluded.external_name, external_status = excluded.external_status,
               template_type = excluded.template_type, variable_schema = excluded.variable_schema, last_synced_at = now(), version = sms_kit.template.version + 1, updated_at = now()`,
            [candidate.id, signature.rows[0].id, snapshot.templateKey, snapshot.externalCode, snapshot.externalName, snapshot.externalStatus, snapshot.templateType, snapshot.purpose, JSON.stringify(snapshot.variableNames)],
          );
        }
        await db.query("update sms_kit.resource_sync_candidate set committed_at = now() where id = $1", [candidate.id]);
      }
      await db.query("update sms_kit.resource_sync set status = 'succeeded', finished_at = now(), summary = jsonb_build_object('committedCount', $2::integer) where id = $1", [input.syncId, candidates.length]);
      const result = candidates.map((candidate) => candidate.resource_type === "signature" ? ({
        id: candidate.id, externalKey: candidate.external_key, changeType: candidate.change_type, checksum: candidate.checksum,
        resourceType: "signature", snapshot: candidate.snapshot,
      }) : ({
        id: candidate.id, externalKey: candidate.external_key, changeType: candidate.change_type, checksum: candidate.checksum,
        resourceType: "template", snapshot: candidate.snapshot,
        signatureExternalKey: (candidate.snapshot as { signatureExternalKey: string }).signatureExternalKey,
        templateKey: (candidate.snapshot as { templateKey: string }).templateKey,
        purpose: (candidate.snapshot as { purpose: string }).purpose,
      })) as unknown as readonly ResourceSyncCandidate[];
      return { id: input.syncId, status: "succeeded", expiresAt: sync.rows[0].expires_at, candidates: result };
    });
  }
}
