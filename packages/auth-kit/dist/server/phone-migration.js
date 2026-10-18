import { normalizeMainlandNationalPhone } from "sms-kit/core";
/** Explicit maintenance-window migration. Never invoked by createAuthKit. */
export async function migrateAuthPhoneStorage(pool, namespace = "auth_kit") {
    if (!/^[a-z][a-z0-9_]{0,47}$/.test(namespace) || namespace === "public") {
        throw new Error("Use a dedicated lowercase PostgreSQL schema");
    }
    const client = await pool.connect();
    let broken = false;
    try {
        await client.query("BEGIN");
        await client.query(`LOCK TABLE "${namespace}"."user" IN ACCESS EXCLUSIVE MODE`);
        const { rows } = await client.query(`SELECT id, phone_number FROM "${namespace}"."user"`);
        const normalized = rows.map((row) => ({ ...row, phone: row.phone_number === null ? null : normalizeMainlandNationalPhone(row.phone_number) }));
        if (new Set(normalized.filter(row => row.phone !== null).map(row => row.phone)).size !== normalized.filter(row => row.phone !== null).length) {
            throw new Error("Phone normalization collision; resolve account ownership before migration");
        }
        let changed = 0;
        for (const row of normalized) {
            if (row.phone === row.phone_number)
                continue;
            await client.query(`UPDATE "${namespace}"."user" SET phone_number=$1, updated_at=now() WHERE id=$2`, [row.phone, row.id]);
            await client.query(`DELETE FROM "${namespace}".session WHERE user_id=$1`, [row.id]);
            changed++;
        }
        const constraint = await client.query("SELECT 1 FROM pg_constraint WHERE conrelid=$1::regclass AND conname='user_phone_national'", [`${namespace}.user`]);
        if (!constraint.rowCount)
            await client.query(`ALTER TABLE "${namespace}"."user" ADD CONSTRAINT user_phone_national CHECK (phone_number ~ '^1[3-9][0-9]{9}$')`);
        await client.query("COMMIT");
        return changed;
    }
    catch (error) {
        try {
            await client.query("ROLLBACK");
        }
        catch {
            broken = true;
        }
        throw error;
    }
    finally {
        client.release(broken);
    }
}
