import type { Pool, PoolClient } from "pg";

import { SmsKitError } from "../../core/errors.js";
import { isCloudApproved, isUsableSignature } from "../../core/resource-usability.js";
import type {
  ImportTemplateResourceInput, ResourceRepository, ResourceSyncCandidate, ResourceSyncPreview, Signature,
  SmsTransaction, Template, TemplateResourceSelection, UpdateSignatureResourceInput, UpdateTemplateResourceInput,
} from "../../ports/store.js";
import { hasTemplateResourceSelection } from "../../ports/store.js";
import type { PgSmsTransaction } from "../transaction.js";

type Queryable = Pool | PoolClient;
type CandidateRow = {
  id: string; resource_type: "signature" | "template"; external_key: string;
  change_type: ResourceSyncCandidate["changeType"]; checksum: string; snapshot: unknown;
  committed_at: Date | null;
};
type SignatureRow = {
  id: string; external_key: string; external_name: string; external_status: string;
  external_type: string; enabled: boolean; version: string;
};
type TemplateRow = {
  id: string; signature_id: string; template_key: string; external_code: string; external_name: string;
  external_status: string; template_type: "verification" | "notification"; purpose: string;
  variable_schema: unknown; enabled: boolean; version: string;
};
type ImportCandidateRow = CandidateRow & Readonly<{
  expires_at: Date;
  committed_at: Date | null;
}>;

const signatureFields = "id, external_key, external_name, external_status, external_type, enabled, version";
const templateFields = "id, signature_id, template_key, external_code, external_name, external_status, template_type, purpose, variable_schema, enabled, version";

function queryable(pool: Pool, tx?: SmsTransaction): Queryable {
  return tx === undefined ? pool : (tx as PgSmsTransaction).client;
}

function transactionClient(tx: SmsTransaction): PoolClient {
  const client = (tx as unknown as Partial<PgSmsTransaction>).client;
  if (client === undefined) {
    throw new SmsKitError("STORAGE_FAILURE", "resource mutation requires a store transaction", true);
  }
  return client;
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

function signature(row: SignatureRow): Signature {
  return { id: row.id, externalKey: row.external_key, externalName: row.external_name, externalStatus: row.external_status, externalType: row.external_type, enabled: row.enabled, version: Number(row.version) };
}

function template(row: TemplateRow): Template {
  const names = Array.isArray(row.variable_schema) ? row.variable_schema.filter((name): name is string => typeof name === "string") : [];
  return { id: row.id as Template["id"], signatureId: row.signature_id, templateKey: row.template_key, externalCode: row.external_code, externalName: row.external_name, externalStatus: row.external_status, templateType: row.template_type, purpose: row.purpose, variables: names.map((name) => ({ name, sensitive: false })), enabled: row.enabled, version: Number(row.version) };
}

function object(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SmsKitError("STORAGE_FAILURE", "resource candidate snapshot is invalid", true);
  }
  return value as Readonly<Record<string, unknown>>;
}

function requiredString(value: Readonly<Record<string, unknown>>, key: string): string {
  const result = value[key];
  if (typeof result !== "string" || result.length === 0) {
    throw new SmsKitError("STORAGE_FAILURE", "resource candidate snapshot is invalid", true);
  }
  return result;
}

type StoredTemplateSnapshot = Readonly<{
  externalCode: string;
  externalName: string;
  externalStatus: string;
  templateType: "verification" | "notification";
  variableNames: readonly string[];
}> & Readonly<Partial<TemplateResourceSelection>>;

function hasStoredTemplateSelection(
  snapshot: StoredTemplateSnapshot,
): snapshot is StoredTemplateSnapshot & TemplateResourceSelection {
  return typeof snapshot.signatureExternalKey === "string" &&
    typeof snapshot.templateKey === "string" &&
    typeof snapshot.purpose === "string";
}

function importSnapshot(value: unknown): StoredTemplateSnapshot {
  const snapshot = object(value);
  const templateType = requiredString(snapshot, "templateType");
  const variableNames = snapshot.variableNames;
  if (snapshot.kind !== "template" || !["verification", "notification"].includes(templateType) ||
      !Array.isArray(variableNames) || !variableNames.every((name) => typeof name === "string")) {
    throw new SmsKitError("STORAGE_FAILURE", "resource candidate snapshot is invalid", true);
  }
  const providerSnapshot = {
    externalCode: requiredString(snapshot, "externalCode"),
    externalName: requiredString(snapshot, "externalName"),
    externalStatus: requiredString(snapshot, "externalStatus"),
    templateType: templateType as "verification" | "notification",
    variableNames,
  };
  const hasSelection = ["signatureExternalKey", "templateKey", "purpose"]
    .some((key) => snapshot[key] !== undefined);
  if (!hasSelection) return providerSnapshot;
  return {
    ...providerSnapshot,
    signatureExternalKey: requiredString(snapshot, "signatureExternalKey"),
    templateKey: requiredString(snapshot, "templateKey"),
    purpose: requiredString(snapshot, "purpose"),
  };
}

function pgCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function safeSnapshot(candidate: ResourceSyncCandidate): object {
  if (candidate.resourceType === "signature") {
    return { kind: "signature", externalName: candidate.snapshot.externalName, externalStatus: candidate.snapshot.externalStatus, externalType: candidate.snapshot.externalType };
  }
  return {
    kind: "template", externalCode: candidate.snapshot.externalCode, externalName: candidate.snapshot.externalName,
    externalStatus: candidate.snapshot.externalStatus, templateType: candidate.snapshot.templateType,
    variableNames: [...candidate.snapshot.variableNames],
    ...(hasTemplateResourceSelection(candidate) ? {
      signatureExternalKey: candidate.signatureExternalKey,
      templateKey: candidate.templateKey,
      purpose: candidate.purpose,
    } : {}),
  };
}

/**
 * Every sender and administrator that touches an existing template obtains the
 * template row before its signature row. A sync can mutate a parent signature
 * and all of its children, so it must first lock the already-imported children
 * in that same order. Otherwise a sender holding `template FOR SHARE` and a
 * sync holding `signature FOR UPDATE` form a deadlock cycle.
 */
type ResourceLockScope = Readonly<{
  templateExternalCodes: readonly string[];
  templateKeys: readonly string[];
  signatureExternalKeys: readonly string[];
  signatureNameTypes: readonly string[];
}>;

function resourceLockScope(candidates: readonly CandidateRow[]): ResourceLockScope {
  const externalCodes = new Set<string>();
  const templateKeys = new Set<string>();
  const signatureExternalKeys = new Set<string>();
  const signatureNameTypes = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.resource_type === "signature") {
      signatureExternalKeys.add(candidate.external_key);
      if (candidate.change_type !== "unavailable") {
        const snapshot = object(candidate.snapshot);
        signatureNameTypes.add(JSON.stringify([
          requiredString(snapshot, "externalName"),
          requiredString(snapshot, "externalType"),
        ]));
      }
      continue;
    }
    const snapshot = typeof candidate.snapshot === "object" && candidate.snapshot !== null && !Array.isArray(candidate.snapshot)
      ? candidate.snapshot as Record<string, unknown>
      : undefined;
    if (typeof snapshot?.externalCode === "string") externalCodes.add(snapshot.externalCode);
    // Only a new import writes the stable key. Changed/unchanged provider
    // refreshes deliberately preserve the existing local key.
    if (candidate.change_type === "new" && typeof snapshot?.templateKey === "string") {
      templateKeys.add(snapshot.templateKey);
    }
    if (typeof snapshot?.signatureExternalKey === "string") signatureExternalKeys.add(snapshot.signatureExternalKey);
  }
  return {
    templateExternalCodes: [...externalCodes].sort(),
    templateKeys: [...templateKeys].sort(),
    signatureExternalKeys: [...signatureExternalKeys].sort(),
    signatureNameTypes: [...signatureNameTypes].sort(),
  };
}

/**
 * New resources have no rows to lock, but both tables have more than one
 * unique identity. Acquire all affected identities in one lexicographic
 * namespace before touching either table: template external-code/stable-key,
 * and signature external-key/name+type. Hash collisions merely serialize
 * unrelated work and cannot break safety.
 */
async function lockResourceIdentities(
  db: Queryable,
  input: Readonly<{
    templateExternalCodes?: readonly string[];
    templateKeys?: readonly string[];
    signatureExternalKeys?: readonly string[];
    signatureNameTypes?: readonly string[];
  }>,
): Promise<void> {
  const identities = [...new Set([
    ...(input.templateExternalCodes ?? []).map((value) => `sms-kit:template-code:${value}`),
    ...(input.templateKeys ?? []).map((value) => `sms-kit:template-key:${value}`),
    ...(input.signatureExternalKeys ?? []).map((value) => `sms-kit:signature-key:${value}`),
    ...(input.signatureNameTypes ?? []).map((value) => `sms-kit:signature-name-type:${value}`),
  ])].sort();
  for (const identity of identities) {
    await db.query("select pg_advisory_xact_lock(hashtext($1))", [identity]);
  }
}

type ExistingTemplateSelectionRow = Readonly<{
  external_code: string;
  template_key: string;
  purpose: string;
  signature_external_key: string;
}>;
type ExistingSignatureIdentityRow = Readonly<{
  external_name: string;
  external_type: string;
}>;
type ExistingTemplateParentRow = Readonly<{
  signature_external_key: string;
}>;
/**
 * A later provider refresh must retain an already imported template's parent
 * signature. Add those existing parents before the shared resource lock
 * phase, so refreshes and parent/signature updates use template-then-parent
 * ordering even when a stale preview supplied a different selection.
 */
async function includePersistedTemplateParents(
  db: Queryable,
  scope: ResourceLockScope,
): Promise<ResourceLockScope> {
  if (scope.templateExternalCodes.length === 0) return scope;
  const { rows } = await db.query<ExistingTemplateParentRow>(
    `select s.external_key as signature_external_key
       from sms_kit.template t
       join sms_kit.signature s on s.id = t.signature_id
      where t.external_code = any($1::text[])`,
    [scope.templateExternalCodes],
  );
  const signatureExternalKeys = new Set(scope.signatureExternalKeys);
  for (const row of rows) signatureExternalKeys.add(row.signature_external_key);
  return { ...scope, signatureExternalKeys: [...signatureExternalKeys].sort() };
}

/**
 * A signature upsert can change its `(external_name, external_type)` unique
 * identity. Include the currently persisted identity before taking any
 * advisory lock so two cross-renames acquire the same complete sorted set.
 */
async function includePersistedSignatureIdentities(
  db: Queryable,
  scope: ResourceLockScope,
): Promise<ResourceLockScope> {
  if (scope.signatureExternalKeys.length === 0) return scope;
  const { rows } = await db.query<ExistingSignatureIdentityRow>(
    `select external_name, external_type
       from sms_kit.signature
      where external_key = any($1::text[])`,
    [scope.signatureExternalKeys],
  );
  const signatureNameTypes = new Set(scope.signatureNameTypes);
  for (const row of rows) {
    signatureNameTypes.add(JSON.stringify([row.external_name, row.external_type]));
  }
  return { ...scope, signatureNameTypes: [...signatureNameTypes].sort() };
}

/** A sync refresh may observe local mappings, but can never create or change them. */
async function assertTemplateSelectionsCurrent(
  db: Queryable,
  candidates: readonly CandidateRow[],
): Promise<void> {
  const expectedSelections = new Map<string, Readonly<{
    templateKey: string;
    purpose: string;
    signatureExternalKey: string;
  }>>();
  for (const candidate of candidates) {
    if (candidate.resource_type !== "template" || candidate.change_type === "unavailable") continue;
    const snapshot = importSnapshot(candidate.snapshot);
    if (!hasStoredTemplateSelection(snapshot)) {
      throw new SmsKitError("CONFIG_INVALID", "new templates require an explicit import");
    }
    const selection = {
      templateKey: snapshot.templateKey,
      purpose: snapshot.purpose,
      signatureExternalKey: snapshot.signatureExternalKey,
    };
    const previous = expectedSelections.get(snapshot.externalCode);
    if (previous !== undefined && (previous.templateKey !== selection.templateKey ||
        previous.purpose !== selection.purpose ||
        previous.signatureExternalKey !== selection.signatureExternalKey)) {
      throw new SmsKitError("CONCURRENT_MODIFICATION", "template selection changed concurrently");
    }
    expectedSelections.set(snapshot.externalCode, selection);
  }
  const externalCodes = [...expectedSelections.keys()];
  if (externalCodes.length === 0) return;
  const { rows } = await db.query<ExistingTemplateSelectionRow>(
    `select t.external_code, t.template_key, t.purpose, s.external_key as signature_external_key
       from sms_kit.template t
       join sms_kit.signature s on s.id = t.signature_id
      where t.external_code = any($1::text[])`,
    [externalCodes],
  );
  if (rows.length !== expectedSelections.size) {
    throw new SmsKitError("CONCURRENT_MODIFICATION", "template selection changed concurrently");
  }
  for (const row of rows) {
    const expected = expectedSelections.get(row.external_code);
    if (expected === undefined || expected.templateKey !== row.template_key || expected.purpose !== row.purpose ||
        expected.signatureExternalKey !== row.signature_external_key) {
      throw new SmsKitError("CONCURRENT_MODIFICATION", "template selection changed concurrently");
    }
  }
}

async function lockAffectedTemplates(db: Queryable, scope: ResourceLockScope): Promise<void> {
  if (scope.templateExternalCodes.length === 0 && scope.signatureExternalKeys.length === 0) return;
  await db.query(
    `select id
       from sms_kit.template
      where external_code = any($1::text[])
         or signature_id in (
           select id from sms_kit.signature where external_key = any($2::text[])
         )
      order by id
      for update`,
    [scope.templateExternalCodes, scope.signatureExternalKeys],
  );
}

/** Lock existing parents in stable external-key order after their child templates. */
async function lockAffectedSignatures(db: Queryable, scope: ResourceLockScope): Promise<void> {
  if (scope.signatureExternalKeys.length === 0) return;
  await db.query(
    `select id
       from sms_kit.signature
      where external_key = any($1::text[])
      order by external_key, id
      for update`,
    [scope.signatureExternalKeys],
  );
}

/** Parent sync rows are locked by callers; summarize every committed candidate atomically. */
async function updateSyncProgress(
  db: Queryable,
  syncId: string,
): Promise<"running" | "succeeded"> {
  const progress = await db.query<{ remaining: string; committed: string }>(
    `select count(*) filter (where committed_at is null)::text as remaining,
            count(*) filter (where committed_at is not null)::text as committed
       from sms_kit.resource_sync_candidate
      where sync_id = $1`,
    [syncId],
  );
  const remaining = Number(progress.rows[0]?.remaining ?? "0");
  const committed = Number(progress.rows[0]?.committed ?? "0");
  if (remaining === 0) {
    await db.query(
      "update sms_kit.resource_sync set status = 'succeeded', finished_at = now(), summary = jsonb_build_object('committedCount', $2::integer) where id = $1 and status = 'running'",
      [syncId, committed],
    );
    return "succeeded";
  }
  // Keep the batch runnable until every persisted candidate has a committed
  // marker. The HTTP layer exposes this live state as its public `partial`
  // result without making the remainder unreachable.
  await db.query(
    "update sms_kit.resource_sync set summary = jsonb_build_object('committedCount', $2::integer) where id = $1 and status = 'running'",
    [syncId, committed],
  );
  return "running";
}

/**
 * `external_key` is the durable provider identity. A provider can replace an
 * unavailable signature with a new external key while retaining its visible
 * name/type, and two active signatures can exchange those display values in a
 * single snapshot. Mark every existing signature selected by this batch as
 * temporarily unavailable before its final snapshot is applied. The partial
 * active-identity index then cannot observe an invalid intermediate state;
 * this is transaction-private and deliberately does not advance versions.
 */
async function stageExistingSignaturesUnavailable(
  db: Queryable,
  candidates: readonly CandidateRow[],
): Promise<void> {
  const externalKeys = [...new Set(candidates
    .filter((candidate) => candidate.resource_type === "signature")
    .map((candidate) => candidate.external_key))].sort();
  if (externalKeys.length === 0) return;
  await db.query(
    `update sms_kit.signature
        set external_status = 'unavailable'
      where external_key = any($1::text[])
        and external_status <> 'unavailable'`,
    [externalKeys],
  );
}

export class PgResourceRepository implements ResourceRepository {
  constructor(private readonly pool: Pool) {}

  async findSignatureById(input: Readonly<{ id: string }>, tx?: SmsTransaction): Promise<Signature | undefined> {
    const { rows } = await queryable(this.pool, tx).query<SignatureRow>(`select ${signatureFields} from sms_kit.signature where id = $1${tx === undefined ? "" : " for share"}`, [input.id]);
    return rows[0] === undefined ? undefined : signature(rows[0]);
  }

  async listSignatures(input: Readonly<{ page: number; pageSize: number }>, tx?: SmsTransaction): Promise<{ items: readonly Signature[]; total: number }> {
    const db = queryable(this.pool, tx);
    const [items, count] = await Promise.all([
      db.query<SignatureRow>(`select ${signatureFields} from sms_kit.signature order by external_name, id limit $1 offset $2`, [input.pageSize, (input.page - 1) * input.pageSize]),
      db.query<{ total: string }>("select count(*)::text as total from sms_kit.signature"),
    ]);
    return { items: items.rows.map(signature), total: Number(count.rows[0]?.total ?? "0") };
  }

  async listTemplates(input: Readonly<{ page: number; pageSize: number }>, tx?: SmsTransaction): Promise<{ items: readonly Template[]; total: number }> {
    const db = queryable(this.pool, tx);
    const [items, count] = await Promise.all([
      db.query<TemplateRow>(`select ${templateFields} from sms_kit.template order by template_key limit $1 offset $2`, [input.pageSize, (input.page - 1) * input.pageSize]),
      db.query<{ total: string }>("select count(*)::text as total from sms_kit.template"),
    ]);
    return { items: items.rows.map(template), total: Number(count.rows[0]?.total ?? "0") };
  }

  async findTemplateByKey(input: Readonly<{ templateKey: string }>, tx?: SmsTransaction): Promise<Template | undefined> {
    const { rows } = await queryable(this.pool, tx).query<TemplateRow>(`select ${templateFields} from sms_kit.template where template_key = $1${tx === undefined ? "" : " for share"}`, [input.templateKey]);
    return rows[0] === undefined ? undefined : template(rows[0]);
  }

  async updateSignature(input: UpdateSignatureResourceInput, tx: SmsTransaction): Promise<Signature> {
    const db = transactionClient(tx);
    const current = await db.query<SignatureRow>(
      `select ${signatureFields} from sms_kit.signature where id = $1 for update`,
      [input.id],
    );
    const row = current.rows[0];
    if (row === undefined) throw new SmsKitError("SIGNATURE_UNAVAILABLE", "signature does not exist");
    if (Number(row.version) !== input.expectedVersion) {
      throw new SmsKitError("CONCURRENT_MODIFICATION", "signature changed concurrently");
    }
    if (input.enabled && !isCloudApproved(row.external_status)) {
      throw new SmsKitError("SIGNATURE_UNAVAILABLE", "signature is not cloud-approved");
    }
    const updated = await db.query<SignatureRow>(
      `update sms_kit.signature
          set enabled = $2, version = version + 1, updated_at = now()
        where id = $1 and version = $3
      returning ${signatureFields}`,
      [input.id, input.enabled, input.expectedVersion],
    );
    if (updated.rows[0] === undefined) throw new SmsKitError("CONCURRENT_MODIFICATION", "signature changed concurrently");
    return signature(updated.rows[0]);
  }

  async importTemplate(input: ImportTemplateResourceInput, tx: SmsTransaction): Promise<Template> {
    const db = transactionClient(tx);
    // Match commitSync's lock order: parent batch, then selected candidate, then
    // the shared signature row. This keeps independent imports and batch commits
    // serializable without handing transaction ownership to callers.
    const candidateReference = await db.query<{ sync_id: string }>(
      "select sync_id from sms_kit.resource_sync_candidate where id = $1 and resource_type = 'template'",
      [input.candidateId],
    );
    const syncId = candidateReference.rows[0]?.sync_id;
    if (syncId === undefined) throw new SmsKitError("CONCURRENT_MODIFICATION", "template candidate is no longer current");
    const sync = await db.query<{ status: ResourceSyncPreview["status"]; expires_at: Date }>(
      "select status, expires_at from sms_kit.resource_sync where id = $1 for update",
      [syncId],
    );
    const syncRow = sync.rows[0];
    if (syncRow === undefined || syncRow.status !== "running" || syncRow.expires_at <= input.now) {
      throw new SmsKitError("CONCURRENT_MODIFICATION", "template preview is no longer current");
    }
    const selected = await db.query<ImportCandidateRow>(
      `select c.id, c.resource_type, c.external_key, c.change_type, c.checksum, c.snapshot,
              c.expires_at, c.committed_at
         from sms_kit.resource_sync_candidate c
        where c.id = $1 and c.sync_id = $2 and c.resource_type = 'template'
        for update of c`,
      [input.candidateId, syncId],
    );
    const candidate = selected.rows[0];
    if (candidate === undefined || candidate.committed_at !== null || candidate.expires_at <= input.now ||
        candidate.checksum !== input.checksum || candidate.change_type !== "new") {
      throw new SmsKitError("CONCURRENT_MODIFICATION", "template candidate is no longer current");
    }
    const snapshot = importSnapshot(candidate.snapshot);
    if (hasStoredTemplateSelection(snapshot) &&
        (snapshot.templateKey !== input.templateKey || snapshot.purpose !== input.purpose ||
          snapshot.signatureExternalKey !== input.signatureExternalKey)) {
      throw new SmsKitError("CONCURRENT_MODIFICATION", "template candidate selection changed");
    }
    if (!isCloudApproved(snapshot.externalStatus)) {
      throw new SmsKitError("TEMPLATE_UNAVAILABLE", "template is not cloud-approved");
    }
    const candidateScope = resourceLockScope([candidate]);
    const identityScope = await includePersistedSignatureIdentities(db, {
      ...candidateScope,
      templateKeys: [...new Set([...candidateScope.templateKeys, input.templateKey])].sort(),
      signatureExternalKeys: [...new Set([...candidateScope.signatureExternalKeys, input.signatureExternalKey])].sort(),
    });
    await lockResourceIdentities(db, identityScope);
    const owner = await db.query<SignatureRow>(
      `select ${signatureFields} from sms_kit.signature where external_key = $1 for share`,
      [input.signatureExternalKey],
    );
    const signatureRow = owner.rows[0];
    if (signatureRow === undefined || !isUsableSignature({
      enabled: signatureRow.enabled,
      externalStatus: signatureRow.external_status,
    })) throw new SmsKitError("SIGNATURE_UNAVAILABLE", "template signature is not usable");
    if (Number(signatureRow.version) !== input.expectedSignatureVersion) {
      throw new SmsKitError("CONCURRENT_MODIFICATION", "template signature changed concurrently");
    }
    try {
      const inserted = await db.query<TemplateRow>(
        `insert into sms_kit.template (
           id, signature_id, template_key, external_code, external_name, external_status,
           template_type, purpose, content_snapshot, variable_schema, imported_at, last_synced_at,
           created_at, updated_at
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, '', $9::jsonb, now(), now(), now(), now())
         returning ${templateFields}`,
        [candidate.id, signatureRow.id, input.templateKey, snapshot.externalCode, snapshot.externalName,
          snapshot.externalStatus, snapshot.templateType, input.purpose, JSON.stringify(snapshot.variableNames)],
      );
      const committed = await db.query(
        "update sms_kit.resource_sync_candidate set committed_at = now() where id = $1 and committed_at is null",
        [candidate.id],
      );
      if (committed.rowCount !== 1) throw new SmsKitError("CONCURRENT_MODIFICATION", "template candidate was already committed");
      await updateSyncProgress(db, syncId);
      return template(inserted.rows[0]!);
    } catch (error) {
      if (pgCode(error) === "23505") {
        throw new SmsKitError("CONCURRENT_MODIFICATION", "template identity is already imported");
      }
      throw error;
    }
  }

  async updateTemplate(input: UpdateTemplateResourceInput, tx: SmsTransaction): Promise<Template> {
    const db = transactionClient(tx);
    // A rename competes with both a new import (which has no row to lock) and
    // another rename. Read the existing key first, lock old and target keys in
    // the same global order as a sync, then take the row lock. The version
    // fence below turns a concurrent intervening rename into a safe conflict.
    if (input.templateKey !== undefined) {
      const existing = await db.query<{ template_key: string }>(
        "select template_key from sms_kit.template where id = $1",
        [input.id],
      );
      if (existing.rows[0] !== undefined) {
        await lockResourceIdentities(db, {
          templateKeys: [existing.rows[0].template_key, input.templateKey],
        });
      } else {
        await lockResourceIdentities(db, { templateKeys: [input.templateKey] });
      }
    }
    const current = await db.query<TemplateRow>(
      `select ${templateFields} from sms_kit.template where id = $1 for update`,
      [input.id],
    );
    const row = current.rows[0];
    if (row === undefined) throw new SmsKitError("TEMPLATE_UNAVAILABLE", "template does not exist");
    if (Number(row.version) !== input.expectedVersion) {
      throw new SmsKitError("CONCURRENT_MODIFICATION", "template changed concurrently");
    }
    const nextKey = input.templateKey ?? row.template_key;
    if (nextKey !== row.template_key) {
      // This statement intentionally runs after the template row lock. At READ
      // COMMITTED it sees a send that was allowed to commit before this lock.
      const used = await db.query<{ used: boolean }>(
        "select exists (select 1 from sms_kit.send_message where template_id = $1) as used",
        [row.id],
      );
      if (used.rows[0]?.used) {
        throw new SmsKitError("CONCURRENT_MODIFICATION", "stable template key is already in use");
      }
    }
    const nextEnabled = input.enabled ?? row.enabled;
    if (nextEnabled) {
      if (!isCloudApproved(row.external_status)) throw new SmsKitError("TEMPLATE_UNAVAILABLE", "template is not cloud-approved");
      const owner = await db.query<SignatureRow>(
        `select ${signatureFields} from sms_kit.signature where id = $1 for share`,
        [row.signature_id],
      );
      if (owner.rows[0] === undefined || !isUsableSignature({
        enabled: owner.rows[0].enabled,
        externalStatus: owner.rows[0].external_status,
      })) throw new SmsKitError("SIGNATURE_UNAVAILABLE", "template signature is not usable");
    }
    try {
      const updated = await db.query<TemplateRow>(
        `update sms_kit.template
            set template_key = $2, purpose = $3, enabled = $4,
                version = version + 1, updated_at = now()
          where id = $1 and version = $5
        returning ${templateFields}`,
        [row.id, nextKey, input.purpose ?? row.purpose, nextEnabled, input.expectedVersion],
      );
      if (updated.rows[0] === undefined) throw new SmsKitError("CONCURRENT_MODIFICATION", "template changed concurrently");
      return template(updated.rows[0]);
    } catch (error) {
      if (pgCode(error) === "23505") throw new SmsKitError("CONCURRENT_MODIFICATION", "template key is already in use");
      throw error;
    }
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
      // Candidate UUIDs are generated independently per preview.  Ordering by
      // them lets two overlapping syncs acquire new resource unique-index
      // locks in opposite orders.  Use provider-stable identities instead;
      // template external code is the actual uniqueness key for template
      // upserts, while external_key remains the deterministic tiebreaker.
      const candidates = ids.length === 0 ? [] : (await db.query<CandidateRow>("select id, resource_type, external_key, change_type, checksum, snapshot, committed_at from sms_kit.resource_sync_candidate where sync_id = $1 and id = any($2::uuid[]) order by case resource_type when 'signature' then 0 else 1 end, case resource_type when 'template' then coalesce(snapshot ->> 'externalCode', external_key) else external_key end, external_key, id for update", [input.syncId, ids])).rows;
      if (candidates.length !== input.candidates.length || candidates.some((candidate) => candidate.committed_at !== null || input.candidates.find((chosen) => chosen.id === candidate.id)?.checksum !== candidate.checksum)) {
        throw new SmsKitError("CONCURRENT_MODIFICATION", "resource preview checksum changed");
      }
      for (const candidate of candidates) {
        if (candidate.resource_type !== "template") continue;
        if (candidate.change_type === "new") {
          // A preview may pre-date the explicit-import boundary or may have
          // been created by a direct application caller. Never trust a stored
          // local mapping to turn resource.sync into template.manage.
          throw new SmsKitError("CONFIG_INVALID", "new templates require an explicit import");
        }
        if (!hasStoredTemplateSelection(importSnapshot(candidate.snapshot))) {
          throw new SmsKitError("CONFIG_INVALID", "imported templates require their persisted local mapping");
        }
      }
      // Provider snapshots can change multiple overlapping identity rows. A
      // single transaction-level commit lock makes their persisted-name reads,
      // identity staging, and final unique-index writes one serial sequence.
      // Direct template/import mutations still use the narrower locks below.
      await db.query("select pg_advisory_xact_lock(hashtext('sms-kit:resource-sync-commit'))");
      // Template-before-signature is the shared resource lock order. This must
      // precede the signature upserts below, including unavailable-parent
      // updates that subsequently disable every child template.
      const scopeWithParents = await includePersistedTemplateParents(db, resourceLockScope(candidates));
      const scope = await includePersistedSignatureIdentities(db, scopeWithParents);
      await lockResourceIdentities(db, {
        templateExternalCodes: scope.templateExternalCodes,
        templateKeys: scope.templateKeys,
        signatureExternalKeys: scope.signatureExternalKeys,
        signatureNameTypes: scope.signatureNameTypes,
      });
      await lockAffectedTemplates(db, scope);
      await lockAffectedSignatures(db, scope);
      await assertTemplateSelectionsCurrent(db, candidates);
      await stageExistingSignaturesUnavailable(db, candidates);
      try {
        for (const candidate of candidates) {
          if (candidate.resource_type === "signature") {
          const snapshot = candidate.snapshot as Extract<ResourceSyncCandidate, { resourceType: "signature" }>["snapshot"];
          if (candidate.change_type === "unavailable") {
            await db.query(
              "update sms_kit.signature set external_status = 'unavailable', enabled = false, last_synced_at = now(), version = version + 1, updated_at = now() where external_key = $1",
              [candidate.external_key],
            );
            await db.query(
              `update sms_kit.template set external_status = 'unavailable', enabled = false, last_synced_at = now(),
                 version = version + 1, updated_at = now()
               where signature_id in (select id from sms_kit.signature where external_key = $1)`,
              [candidate.external_key],
            );
            await db.query("update sms_kit.resource_sync_candidate set committed_at = now() where id = $1", [candidate.id]);
            continue;
          }
          if (!isCloudApproved(snapshot.externalStatus)) {
            const updated = await db.query("update sms_kit.signature set external_status = $2, enabled = false, last_synced_at = now(), version = version + 1, updated_at = now() where external_key = $1 returning id", [candidate.external_key, snapshot.externalStatus]);
            if (updated.rowCount !== 1) throw new SmsKitError("CONFIG_INVALID", "resource is not cloud-approved");
            await db.query("update sms_kit.template set enabled = false, version = version + 1, updated_at = now() where signature_id = $1", [updated.rows[0].id]);
            await db.query("update sms_kit.resource_sync_candidate set committed_at = now() where id = $1", [candidate.id]);
            continue;
          }
          await db.query(
            `insert into sms_kit.signature (id, external_key, external_name, external_status, external_type, imported_at, last_synced_at, created_at, updated_at)
             values ($1, $2, $3, $4, $5, now(), now(), now(), now())
             on conflict (external_key) do update set external_name = excluded.external_name, external_status = excluded.external_status,
               external_type = excluded.external_type, last_synced_at = now(), version = sms_kit.signature.version + 1, updated_at = now()`,
            [candidate.id, candidate.external_key, snapshot.externalName, snapshot.externalStatus, snapshot.externalType],
          );
        } else {
          const snapshot = importSnapshot(candidate.snapshot);
          if (!hasStoredTemplateSelection(snapshot)) {
            throw new SmsKitError("CONFIG_INVALID", "new templates require an explicit import");
          }
          if (candidate.change_type === "unavailable") {
            await db.query(
              "update sms_kit.template set external_status = 'unavailable', enabled = false, last_synced_at = now(), version = version + 1, updated_at = now() where external_code = $1",
              [snapshot.externalCode],
            );
            await db.query("update sms_kit.resource_sync_candidate set committed_at = now() where id = $1", [candidate.id]);
            continue;
          }
          if (!isCloudApproved(snapshot.externalStatus)) {
            const updated = await db.query("update sms_kit.template set external_status = $2, enabled = false, last_synced_at = now(), version = version + 1, updated_at = now() where external_code = $1", [snapshot.externalCode, snapshot.externalStatus]);
            if (updated.rowCount !== 1) throw new SmsKitError("CONFIG_INVALID", "resource is not cloud-approved");
            await db.query("update sms_kit.resource_sync_candidate set committed_at = now() where id = $1", [candidate.id]);
            continue;
          }
          const signature = await db.query<{ id: string; enabled: boolean; external_status: string }>("select id, enabled, external_status from sms_kit.signature where external_key = $1", [snapshot.signatureExternalKey]);
          if (signature.rows[0] === undefined || !isUsableSignature({
            enabled: signature.rows[0].enabled, externalStatus: signature.rows[0].external_status,
          })) {
            // Refreshing an already imported child must not undo the parent's revocation.
            const updated = signature.rows[0] === undefined ? undefined : await db.query(`update sms_kit.template
              set external_name = $3, external_status = $4, template_type = $5, variable_schema = $6::jsonb,
                  enabled = false, last_synced_at = now(), version = version + 1, updated_at = now()
              where external_code = $1 and signature_id = $2`, [snapshot.externalCode, signature.rows[0].id, snapshot.externalName, snapshot.externalStatus, snapshot.templateType, JSON.stringify(snapshot.variableNames)]);
            if (updated?.rowCount === 1) {
              await db.query("update sms_kit.resource_sync_candidate set committed_at = now() where id = $1", [candidate.id]);
              continue;
            }
            throw new SmsKitError("CONFIG_INVALID", "template preview has no usable signature");
          }
          const updated = await db.query(
            `update sms_kit.template
                set external_name = $5, external_status = $6, template_type = $7,
                    variable_schema = $8::jsonb, last_synced_at = now(), version = version + 1, updated_at = now()
              where external_code = $1 and signature_id = $2 and template_key = $3 and purpose = $4`,
            [snapshot.externalCode, signature.rows[0].id, snapshot.templateKey, snapshot.purpose,
              snapshot.externalName, snapshot.externalStatus, snapshot.templateType, JSON.stringify(snapshot.variableNames)],
          );
          if (updated.rowCount !== 1) {
            throw new SmsKitError("CONCURRENT_MODIFICATION", "template selection changed concurrently");
          }
        }
          await db.query("update sms_kit.resource_sync_candidate set committed_at = now() where id = $1", [candidate.id]);
        }
      } catch (error) {
        // A concurrently committed preview may own a template or signature
        // identity. Any residual unique/deadlock race is an optimistic
        // conflict, not an infrastructure failure leaked as a 500.
        if (pgCode(error) === "23505" || pgCode(error) === "40P01") {
          throw new SmsKitError("CONCURRENT_MODIFICATION", "resource identity changed concurrently");
        }
        throw error;
      }
      const status = await updateSyncProgress(db, input.syncId);
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
      return {
        id: input.syncId,
        status,
        expiresAt: sync.rows[0].expires_at,
        candidates: result,
      };
    });
  }
}
