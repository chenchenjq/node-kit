import { SmsKitError } from "../../core/errors.js";
import { projectSafeEventMetadata } from "../../ports/runtime.js";
function executor(pool, tx) {
    return tx === undefined ? pool : tx.client;
}
function config(row) {
    return {
        provider: row.provider,
        region: row.region,
        ...(row.endpoint === null ? {} : { endpoint: row.endpoint }),
        accessKeyIdRef: row.access_key_id_ref,
        accessKeySecretRef: row.access_key_secret_ref,
        receiptCallbackTokenRef: row.receipt_callback_token_ref,
        status: row.status,
        enabled: row.enabled,
        lastTestStatus: row.last_test_status,
        ...(row.last_test_summary === null ? {} : { lastTestSummary: projectSafeEventMetadata(row.last_test_summary) }),
        ...(row.last_tested_at === null ? {} : { lastTestedAt: row.last_tested_at }),
        version: Number(row.version),
    };
}
export class PgConfigRepository {
    pool;
    constructor(pool) {
        this.pool = pool;
    }
    async get(tx) {
        const { rows } = await executor(this.pool, tx).query(`select provider, region, endpoint, access_key_id_ref, access_key_secret_ref, receipt_callback_token_ref,
              status, enabled, last_test_status, last_test_summary, last_tested_at, version
         from sms_kit.provider_config where id = 1${tx === undefined ? "" : " for update"}`);
        return rows[0] === undefined
            ? { provider: "aliyun", status: "unconfigured", enabled: false, lastTestStatus: "never", version: 0 }
            : config(rows[0]);
    }
    async update(input, tx) {
        const client = executor(this.pool, tx);
        const values = [input.region, input.endpoint ?? null, input.accessKeyIdRef, input.accessKeySecretRef, input.receiptCallbackTokenRef, input.enabled];
        const { rows } = input.expectedVersion === 0
            ? await client.query(`insert into sms_kit.provider_config (
          id, provider, region, endpoint, access_key_id_ref, access_key_secret_ref, receipt_callback_token_ref,
          status, enabled, last_test_status, created_at, updated_at
        ) values (1, 'aliyun', $1, $2, $3, $4, $5, case when $7 then 'untested' when $6 then 'untested' else 'disabled' end, case when $7 then false else $6 end, 'never', now(), now())
        on conflict (id) do nothing
        returning provider, region, endpoint, access_key_id_ref, access_key_secret_ref, receipt_callback_token_ref,
                  status, enabled, last_test_status, last_test_summary, last_tested_at, version`, [...values, input.resetReadiness ?? false])
            : await client.query(`update sms_kit.provider_config set
          region = $1, endpoint = $2, access_key_id_ref = $3, access_key_secret_ref = $4,
          receipt_callback_token_ref = $5, enabled = case when $8 then false else $6 end,
          status = case
            when $8 then 'untested'
            when not $6 then 'disabled'
            when status = 'disabled' and last_test_status = 'succeeded' then 'ready'
            when status = 'disabled' then 'untested'
            else status
          end,
          last_test_status = case when $8 then 'never' else last_test_status end,
          last_test_summary = case when $8 then null else last_test_summary end,
          last_tested_at = case when $8 then null else last_tested_at end,
          version = version + 1, updated_at = now()
        where id = 1 and version = $7
        returning provider, region, endpoint, access_key_id_ref, access_key_secret_ref, receipt_callback_token_ref,
                  status, enabled, last_test_status, last_test_summary, last_tested_at, version`, [...values, input.expectedVersion, input.resetReadiness ?? false]);
        if (rows[0] === undefined)
            throw new SmsKitError("CONCURRENT_MODIFICATION", "provider configuration changed concurrently");
        return config(rows[0]);
    }
    async recordConnectionTest(input, tx) {
        const { rows } = await executor(this.pool, tx).query(`update sms_kit.provider_config
          set last_test_status = $1, last_test_summary = $2::jsonb, last_tested_at = $3,
              status = case when $1 = 'succeeded' then 'ready' else 'degraded' end,
              version = version + 1, updated_at = now()
        where id = 1 and version = $4
      returning provider, region, endpoint, access_key_id_ref, access_key_secret_ref, receipt_callback_token_ref,
                status, enabled, last_test_status, last_test_summary, last_tested_at, version`, [input.status, JSON.stringify(projectSafeEventMetadata(input.summary)), input.testedAt, input.expectedVersion]);
        if (rows[0] === undefined)
            throw new SmsKitError("CONCURRENT_MODIFICATION", "provider configuration changed concurrently");
        return config(rows[0]);
    }
}
