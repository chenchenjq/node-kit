import { randomUUID, createDecipheriv } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { Pool } from "pg";
import { Redis } from "ioredis";
import svgCaptcha from "svg-captcha";
import { createAuthKit, type AuthKit } from "../../src/server/auth.js";
import { authSchemaSql, createAuthSchema } from "../../src/server/schema.js";
import { migrateAuthPhoneStorage } from "../../src/server/phone-migration.js";
import { hashPassword, verifyPassword } from "../../src/server/password.js";
import { SystemAuthSmsService } from "../../../sms-kit/src/application/system-auth-service.js";
import { PgSmsStore, migrateSmsKit } from "../../../sms-kit/src/postgres/index.js";
import { AesGcmPhoneNumberProtector, HmacHasher } from "../../../sms-kit/src/security/index.js";
import { createResourceSyncCandidate } from "../../../sms-kit/src/ports/store.js";
import { commitResourceFixturePreview } from "../../../sms-kit/test/integration/postgres/resource-fixtures.js";
import type { MessageId } from "../../../sms-kit/src/core/types.js";

// Independent disposable PG/Redis. Only the physical SMS provider and captcha text are stubbed.
describe("auth-kit PG/Redis security contract", () => {
  let pgContainer: StartedTestContainer | undefined;
  let redisContainer: StartedTestContainer | undefined;
  let pool: Pool;
  let redis: Redis;
  let kit: AuthKit;
  let sends = 0;
  const secret = "integration-secret-at-least-32-characters";
  const key = Buffer.alloc(32, 7);
  const origin = "http://localhost:3000";
  const oldPassword = "ExistingPassword123";
  let oldHash: string;
  const post = (path: string, body: unknown, cookie = "") => kit.handler(new Request(`${origin}/api/auth-kit${path}`, {
    method: "POST", headers: { origin, "content-type": "application/json", cookie }, body: JSON.stringify(body),
  }));
  async function graphic(purpose = "password-login") {
    const res = await post("/captcha", { purpose });
    expect(res.status).toBe(200);
    return { cookie: res.headers.getSetCookie()[0]!.split(";")[0]!, id: (await res.json()).id };
  }
  async function login(loginId = "operator") {
    const g = await graphic();
    return post("/sign-in/password", { loginId, password: oldPassword, captchaId: g.id, captchaAnswer: "AbCd" }, g.cookie);
  }
  async function issue(purpose = "password-reset") {
    const g = await graphic(purpose);
    const res = await post("/sms/send", { phoneNumber: "+08613800138000", purpose, captchaId: g.id, captchaAnswer: "abcd" }, g.cookie);
    expect(res.status).toBe(200);
  }
  const reset = (code = "123456") => post("/password/reset", { phoneNumber: "13800138000", code, newPassword: "ChangedPassword456" });
  async function credentialState() {
    const credential = (await pool.query('SELECT password FROM auth_harden.account WHERE user_id=$1', ["u1"])).rows[0].password;
    const sessions = (await pool.query('SELECT count(*)::int AS n FROM auth_harden.session')).rows[0].n;
    const challenge = (await pool.query('SELECT verified_at, consumed_at, attempt_count FROM sms_kit.otp_challenge ORDER BY created_at DESC LIMIT 1')).rows[0];
    return { credential, sessions, challenge };
  }
  beforeAll(async () => {
    const testUrl=process.env.SCM_AUTH_TEST_DATABASE_URL;
    if(testUrl){
      if(!new URL(testUrl).pathname.startsWith('/scm_auth_runtime_test_'))throw new Error('Refusing a non-test database');
      pool=new Pool({connectionString:testUrl});redis=new Redis(process.env.SCM_AUTH_TEST_REDIS_URL!);await redis.ping();
    }else{
      pgContainer = await new GenericContainer("postgres@sha256:edb0c08dc33befd0262ab3b5cf1c4f3f8cfd8b09e88c05b45adee29d6761ddb6").withEnvironment({POSTGRES_USER:"test",POSTGRES_PASSWORD:"test",POSTGRES_DB:"auth_test"}).withExposedPorts(5432).withTmpFs({"/var/lib/postgresql":"rw"}).start();
      pool=new Pool({host:pgContainer.getHost(),port:pgContainer.getMappedPort(5432),user:"test",password:"test",database:"auth_test"});
      redisContainer=await new GenericContainer("redis@sha256:e5f23377739f95a2f530b9c99f93accb4f634577f09d00a7d8e0638f2fdf69e0").withExposedPorts(6379).start();redis=new Redis({host:redisContainer.getHost(),port:redisContainer.getMappedPort(6379),maxRetriesPerRequest:1});await redis.ping();
    }
    await pool.query(authSchemaSql("auth_harden"));
    await migrateSmsKit(pool);
    const store = new PgSmsStore(pool);
    const resources = [createResourceSyncCandidate({ id: randomUUID(), externalKey: "sign", checksum: "sig", changeType: "new", resourceType: "signature", snapshot: { kind: "signature", externalName: "Test", externalStatus: "approved", externalType: "text" } })];
    for (const [index, templateKey] of ["auth.login_otp", "auth.password_reset"].entries()) resources.push(createResourceSyncCandidate({ id: randomUUID(), externalKey: `t${index}`, checksum: `tc${index}`, changeType: "new", resourceType: "template", signatureExternalKey: "sign", templateKey, purpose: templateKey, snapshot: { kind: "template", externalCode: `SMS_T${index}`, externalName: "Test", externalStatus: "approved", templateType: "verification", variableNames: ["code"] } }));
    const preview = await store.resources.createSyncPreview({ id: randomUUID(), actorId: "seed", expiresAt: new Date(Date.now() + 86400000), resources });
    await commitResourceFixturePreview(store, preview, new Date());
    const config = await store.config.update({ provider: "aliyun", region: "cn-shanghai", accessKeyIdRef: "env://ID", accessKeySecretRef: "env://SECRET", receiptCallbackTokenRef: "env://TOKEN", enabled: true, expectedVersion: 0 });
    await store.config.recordConnectionTest({ status: "succeeded", summary: {}, testedAt: new Date(), expectedVersion: config.version });
    const sms = new SystemAuthSmsService({ store, repository: store.systemAuth,
      provider: { send: async () => { sends++; return { kind: "accepted", bizId: randomUUID(), requestId: randomUUID() }; } } as never,
      phoneProtector: new AesGcmPhoneNumberProtector({ activeKey: async () => ({ id: "test-key", bytes: key }), keyById: async () => key }, new HmacHasher(Buffer.alloc(32, 8)), { storageFormat: "national" }),
      hasher: new HmacHasher(Buffer.alloc(32, 9)), clock: { now: () => new Date() }, ids: { next: randomUUID, messageId: () => randomUUID() as MessageId },
      providerTimeoutMs: 1000, otpGenerator: { generate: () => "123456" },
    });
    kit = createAuthKit({ appId: "hardening", baseURL: origin, secret, pool, redis, developmentOrigins: ["http://192.168.0.108:3000"],
      schema: createAuthSchema("auth_harden"), sms: { service: sms }, resolveClientIp: () => "127.0.0.1",
      resolveUsername: async (name) => name === "operator" ? "u1" : null,
    });
    vi.spyOn(svgCaptcha, "create").mockReturnValue({ text: "AbCd", data: "<svg/>" });
    oldHash = await hashPassword(oldPassword);
  });
  beforeEach(async () => {
    await pool.query('DROP TRIGGER IF EXISTS fail_write ON auth_harden.account');
    await pool.query('DROP TRIGGER IF EXISTS fail_write ON auth_harden.session');
    await pool.query('TRUNCATE auth_harden."user", sms_kit.otp_challenge, sms_kit.send_message, sms_kit.daily_send_budget, sms_kit.rate_limit_bucket CASCADE');
    await redis.flushdb(); sends = 0;
    await pool.query('INSERT INTO auth_harden."user" (id,name,email,phone_number) VALUES ($1,$2,$3,$4)', ["u1", "User", "u1@auth.invalid", "13800138000"]);
    await pool.query('INSERT INTO auth_harden.account (id,account_id,provider_id,user_id,password) VALUES ($1,$2,$3,$4,$5)', ["a1", "u1", "credential", "u1", oldHash]);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    if (redis) await redis.quit();
    if (pool) await pool.end();
    await redisContainer?.stop(); await pgContainer?.stop();
  });

  it("accepts explicit development LAN origins and rejects the whitelist in production", async () => {
    const res = await kit.handler(new Request(`${origin}/api/auth-kit/captcha`, {method:"POST",headers:{origin:"http://192.168.0.108:3000","content-type":"application/json"},body:'{"purpose":"password-login"}'}));
    expect(res.status).toBe(200); const g = await res.json();
    const signed = await kit.handler(new Request(`${origin}/api/auth-kit/sign-in/password`,{method:"POST",headers:{origin:"http://192.168.0.108:3000","content-type":"application/json",cookie:res.headers.getSetCookie()[0]!.split(";")[0]!},body:JSON.stringify({loginId:"u1@auth.invalid",password:oldPassword,captchaId:g.id,captchaAnswer:"abcd"})}));
    expect(signed.status).toBe(200);
    const original = process.env.NODE_ENV;
    try {process.env.NODE_ENV="production";expect(()=>createAuthKit({appId:"reject-dev",baseURL:origin,secret,pool,redis,schema:createAuthSchema("auth_harden"),sms:{service:{issue:vi.fn(),verifyAndConsume:vi.fn()}},resolveClientIp:()=>"local",developmentOrigins:["http://192.168.0.108:3000"]})).toThrow("Development origins");}
    finally {process.env.NODE_ENV=original;}
  });

  it("keeps email-only legacy accounts, shares email/phone identity, and revokes sessions on password change", async () => {
    expect((await login("U1@AUTH.INVALID")).status).toBe(200);
    await pool.query('UPDATE auth_harden."user" SET phone_number=NULL WHERE id=$1', ["u1"]);
    const logged = await login("u1@auth.invalid");
    expect(logged.status).toBe(200);
    const cookie = logged.headers.getSetCookie().map(x => x.split(";")[0]).join("; ");
    const session = await kit.getSession(new Request(`${origin}/`, { headers: { cookie } }));
    expect(session?.user).toMatchObject({ id: "u1", phoneNumber: null });
    expect((await post("/password/change", { currentPassword: oldPassword, newPassword: "NewEmailPassword456" }, cookie)).status).toBe(200);
    expect(await kit.getSession(new Request(`${origin}/`, { headers: { cookie } }))).toBeNull();
    expect((await login("u1@auth.invalid")).status).toBe(401);
    const g = await graphic();
    expect((await post("/sign-in/password", {loginId: "u1@auth.invalid", password: "NewEmailPassword456", captchaId:g.id,captchaAnswer:"AbCd"}, g.cookie)).status).toBe(200);
  });

  it("normalizes national/+86/+086 input and enforces unique eleven-digit storage", async () => {
    for (const phone of ["13800138000", "+8613800138000", "+08613800138000", "008613800138000"]) expect((await login(phone)).status).toBe(200);
    expect((await login()).status).toBe(200);
    expect((await pool.query('SELECT phone_number FROM auth_harden."user"')).rows).toEqual([{ phone_number: "13800138000" }]);
    await expect(pool.query('UPDATE auth_harden."user" SET phone_number=$1', ["+8613800138000"])).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query('INSERT INTO auth_harden."user" (id,name,email,phone_number) VALUES ($1,$2,$3,$4)', ["u2", "Other", "u2@auth.invalid", "13800138000"])).rejects.toMatchObject({ code: "23505" });
    await issue();
    const message = (await pool.query('SELECT id,phone_ciphertext,phone_key_id FROM sms_kit.send_message')).rows[0];
    const envelope = JSON.parse(Buffer.from(message.phone_ciphertext, "base64url").toString());
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64url"));
    decipher.setAAD(Buffer.from(JSON.stringify([1, message.phone_key_id, "phone", null, message.id, "phone_ciphertext"])));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    expect(Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64url")), decipher.final()]).toString()).toBe("13800138000");
  });

  it("rejects missing, wrong, expired, cross-purpose and cross-browser captchas before sending", async () => {
    expect((await post("/sign-in/password", { loginId: "operator", password: oldPassword })).status).toBe(400);
    const g = await graphic("sms-login");
    const body = { phoneNumber: "13800138000", purpose: "sms-login", captchaId: g.id, captchaAnswer: "abcd" };
    expect((await post("/sms/send", body)).status).toBe(400);
    expect((await post("/sms/send", { ...body, purpose: "password-reset" }, g.cookie)).status).toBe(400);
    expect((await post("/sms/send", { ...body, captchaAnswer: "wrong" }, g.cookie)).status).toBe(400);
    expect((await post("/sms/send", body, g.cookie)).status).toBe(400);
    const expired = await graphic("sms-login");
    const keys = await redis.keys("auth-kit:hardening:captcha:*");
    for (const k of keys) { const value = JSON.parse((await redis.get(k))!); value.expiresAt = 0; await redis.set(k, JSON.stringify(value)); }
    expect((await post("/sms/send", { ...body, captchaId: expired.id }, expired.cookie)).status).toBe(400);
    expect(sends).toBe(0);
  });

  it("consumes one graphic challenge at most once across simultaneous requests", async () => {
    const g = await graphic();
    const body = { loginId: "operator", password: oldPassword, captchaId: g.id, captchaAnswer: "abcd" };
    const results = await Promise.all([post("/sign-in/password", body, g.cookie), post("/sign-in/password", body, g.cookie)]);
    expect(results.map(r => r.status).sort()).toEqual([200, 400]);
  });

  it.each(["account", "session"])("rolls back challenge, proof, password and sessions when %s write fails; same code remains retryable", async (table) => {
    await login(); await login(); await issue();
    await pool.query(`CREATE OR REPLACE FUNCTION auth_harden.fail_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected test failure'; END $$`);
    await pool.query(`CREATE TRIGGER fail_write BEFORE ${table === "account" ? "UPDATE" : "DELETE"} ON auth_harden.${table} FOR EACH ROW EXECUTE FUNCTION auth_harden.fail_write()`);
    expect((await reset()).status).toBe(503);
    const failed = await credentialState();
    expect(failed.credential).toBe(oldHash); expect(failed.sessions).toBe(2);
    expect(failed.challenge).toMatchObject({ verified_at: null, consumed_at: null });
    await pool.query(`DROP TRIGGER fail_write ON auth_harden.${table}`);
    expect((await reset()).status).toBe(200);
    const success = await credentialState();
    expect(await verifyPassword({ hash: success.credential, password: "ChangedPassword456" })).toBe(true);
    expect(success.sessions).toBe(0); expect(success.challenge.consumed_at).toBeInstanceOf(Date);
    expect((await reset()).status).toBe(400);
  });

  it("retains incorrect OTP attempts and consumes a valid code only once under concurrency", async () => {
    await issue();
    expect((await reset("000000")).status).toBe(400);
    expect((await credentialState()).challenge.attempt_count).toBe(1);
    const result = await Promise.all([reset(), reset()]);
    expect(result.map(r => r.status).sort()).toEqual([200, 400]);
  });

  it("rolls back OTP consumption if session creation fails, then permits one SMS login", async () => {
    await issue("sms-login");
    await pool.query(`CREATE OR REPLACE FUNCTION auth_harden.fail_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected test failure'; END $$`);
    await pool.query('CREATE TRIGGER fail_write BEFORE INSERT ON auth_harden.session FOR EACH ROW EXECUTE FUNCTION auth_harden.fail_write()');
    const smsLogin = () => post("/sign-in/sms", { phoneNumber: "13800138000", code: "123456" });
    expect((await smsLogin()).status).toBe(503);
    expect((await credentialState()).challenge).toMatchObject({ verified_at: null, consumed_at: null });
    await pool.query('DROP TRIGGER fail_write ON auth_harden.session');
    const response = await smsLogin();
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie().length).toBeGreaterThan(0);
    expect((await credentialState()).sessions).toBe(1);
    expect((await smsLogin()).status).toBe(400);
  });

  it("rejects a login OTP for reset and rejects correct codes after attempt exhaustion", async () => {
    await issue("sms-login");
    expect((await reset()).status).toBe(400);
    for (let n = 0; n < 3; n++) expect((await post("/sign-in/sms", { phoneNumber: "13800138000", code: "000000" })).status).toBe(400);
    expect((await post("/sign-in/sms", { phoneNumber: "13800138000", code: "123456" })).status).toBe(400);
    expect((await credentialState()).challenge.attempt_count).toBe(3);
    expect((await credentialState()).sessions).toBe(0);
  });

  it("exposes no self-registration endpoint and does not create unknown SMS users", async () => {
    expect((await post("/sign-up/email", { email: "new@example.test", password: oldPassword })).status).toBe(404);
    const g = await graphic("sms-login");
    expect((await post("/sms/send", { phoneNumber: "13900139000", purpose: "sms-login", captchaId: g.id, captchaAnswer: "abcd" }, g.cookie)).status).toBe(200);
    expect(sends).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM auth_harden."user"')).rows[0].n).toBe(1);
  });

  it("migrates legacy numbers atomically, rejects collisions, and is idempotent", async () => {
    await pool.query(authSchemaSql("legacy_auth").replace(" CONSTRAINT user_phone_national CHECK (phone_number ~ '^1[3-9][0-9]{9}$')", ""));
    try {
      await pool.query(`INSERT INTO legacy_auth."user" (id,name,email,phone_number) VALUES ('old1','One','one@auth.invalid','+8613800138000'),('old2','Two','two@auth.invalid','13800138000')`);
      await expect(migrateAuthPhoneStorage(pool, "legacy_auth")).rejects.toThrow("collision");
      expect((await pool.query('SELECT phone_number FROM legacy_auth."user" WHERE id=$1', ["old1"])).rows[0].phone_number).toBe("+8613800138000");
      await pool.query('DELETE FROM legacy_auth."user" WHERE id=$1', ["old2"]);
      expect(await migrateAuthPhoneStorage(pool, "legacy_auth")).toBe(1);
      expect(await migrateAuthPhoneStorage(pool, "legacy_auth")).toBe(0);
    } finally { await pool.query('DROP SCHEMA legacy_auth CASCADE'); }
  });
});
