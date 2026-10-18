import { createHmac, randomUUID } from "node:crypto";

export type RedisConnection = {
  eval(
    script: string,
    numberOfKeys: number,
    ...args: (string | number)[]
  ): Promise<unknown>;
};

const windowScript = `
local now=tonumber(ARGV[1]); local window=tonumber(ARGV[2]); local limit=tonumber(ARGV[3]); local interval=tonumber(ARGV[4]);
local pending=redis.call('ZSCORE',KEYS[1],'pending')
if pending and tonumber(pending)>now then return {0,tonumber(pending)} end
redis.call('ZREM',KEYS[1],'pending')
redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',now-window)
local n=redis.call('ZCARD',KEYS[1]); local retry=now
if n>0 then
 local last=redis.call('ZRANGE',KEYS[1],-1,-1,'WITHSCORES'); retry=math.max(retry,tonumber(last[2])+interval)
end
if n>=limit then
 local first=redis.call('ZRANGE',KEYS[1],0,0,'WITHSCORES'); retry=math.max(retry,tonumber(first[2])+window)
end
if retry>now then return {0,retry} end
redis.call('ZADD',KEYS[1],now,ARGV[5]); redis.call('PEXPIRE',KEYS[1],window)
retry=now+interval
if n+1>=limit then
 local first=redis.call('ZRANGE',KEYS[1],0,0,'WITHSCORES'); retry=math.max(retry,tonumber(first[2])+window)
end
if ARGV[6]=='pending' then redis.call('ZADD',KEYS[1],now+360000,'pending'); redis.call('PEXPIRE',KEYS[1],360000) end
return {1,retry}`;

const captchaConsumeScript = `
local raw=redis.call('GET',KEYS[1]); if not raw then return 0 end
local v=cjson.decode(raw)
if v.id~=ARGV[1] then return 0 end
redis.call('DEL',KEYS[1])
if v.expiresAt<=tonumber(ARGV[3]) or v.digest~=ARGV[2] then return 0 end
return 1`;

export class SecurityState {
  readonly redis: RedisConnection;
  readonly appId: string;
  readonly secret: string;

  constructor(redis: RedisConnection, appId: string, secret: string) {
    this.redis = redis;
    this.appId = appId;
    this.secret = secret;
  }

  key(scope: string, value: string): string {
    return `auth-kit:${this.appId}:${scope}:${createHmac("sha256", this.secret).update(value).digest("hex")}`;
  }

  async now(): Promise<number> {
    const value = await this.redis.eval(
      "local t=redis.call('TIME'); return tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)",
      0
    );
    if (typeof value !== "number" || !Number.isSafeInteger(value))
      throw new Error("Invalid Redis time");
    return value;
  }

  async limit(
    scope: string,
    value: string,
    now: number,
    window: number,
    limit: number,
    interval = 0,
    pending = false
  ): Promise<{ allowed: boolean; retryAt: number }> {
    const result = await this.redis.eval(
      windowScript,
      1,
      this.key(scope, value),
      now,
      window,
      limit,
      interval,
      randomUUID(),
      pending ? "pending" : ""
    );
    if (
      !Array.isArray(result) ||
      result.length !== 2 ||
      !Number.isSafeInteger(result[1])
    )
      throw new Error("Invalid Redis response");
    return { allowed: result[0] === 1, retryAt: result[1] as number };
  }

  reserveSend(
    phone: string,
    now: number,
    pending = false
  ): Promise<{ allowed: boolean; retryAt: number }> {
    return this.limit("sms-hour", phone, now, 3600000, 5, 60000, pending);
  }

  /** Conservative completion-time fence: provider/database latency cannot shorten the next cooldown. */
  async finishSend(phone: string, now: number): Promise<number> {
    const result = await this.redis.eval(
      `
      redis.call('ZREM',KEYS[1],'pending')
      local last=redis.call('ZRANGE',KEYS[1],-1,-1)
      local member=last[1] or ARGV[2]
      redis.call('ZADD',KEYS[1],ARGV[1],member); redis.call('PEXPIRE',KEYS[1],3600000)
      local retry=tonumber(ARGV[1])+60000
      if redis.call('ZCARD',KEYS[1])>=5 then
        local first=redis.call('ZRANGE',KEYS[1],0,0,'WITHSCORES'); retry=math.max(retry,tonumber(first[2])+3600000)
      end
      return retry`,
      1,
      this.key("sms-hour", phone),
      now,
      randomUUID()
    );
    if (typeof result !== "number") throw new Error("Invalid Redis response");
    return result;
  }

  async setActiveChallenge(
    subjectId: string,
    action: string,
    challengeId: string,
    ttlMs: number
  ): Promise<void> {
    await this.redis.eval(
      "return redis.call('SET',KEYS[1],ARGV[1],'PX',ARGV[2])",
      1,
      this.key("challenge", `${subjectId}:${action}`),
      challengeId,
      ttlMs
    );
  }

  async getActiveChallenge(
    subjectId: string,
    action: string
  ): Promise<string | null> {
    const res = await this.redis.eval(
      "return redis.call('GET',KEYS[1])",
      1,
      this.key("challenge", `${subjectId}:${action}`)
    );
    return typeof res === "string" ? res : null;
  }

  async clearActiveChallenge(
    subjectId: string,
    action: string
  ): Promise<void> {
    await this.redis.eval(
      "return redis.call('DEL',KEYS[1])",
      1,
      this.key("challenge", `${subjectId}:${action}`)
    );
  }

  async clearDelivery(identifier: string): Promise<void> {
    await this.redis.eval(
      "return redis.call('DEL',KEYS[1])",
      1,
      this.key("delivery", identifier)
    );
  }

  async acceptDelivery(identifier: string, expiresAt: number): Promise<void> {
    const now = await this.now();
    if (expiresAt <= now) throw new Error("Delivery expired");
    if (
      (await this.redis.eval(
        "return redis.call('SET',KEYS[1],ARGV[1],'PX',ARGV[2])",
        1,
        this.key("delivery", identifier),
        String(expiresAt),
        expiresAt - now
      )) !== "OK"
    )
      throw new Error("Delivery status unavailable");
  }

  /** Stores only native issuance expiry, never SMS code/answer/hash or verification attempt counts. */
  async deliveryAccepted(
    identifier: string,
    expiresAt: number
  ): Promise<boolean> {
    return (
      (await this.redis.eval(
        "return redis.call('GET',KEYS[1])",
        1,
        this.key("delivery", identifier)
      )) === String(expiresAt)
    );
  }

  async saveCaptcha(
    context: string,
    purpose: string,
    id: string,
    answer: string,
    now: number
  ): Promise<void> {
    const key = this.key("captcha", `${context}:${purpose}`);
    const value = JSON.stringify({
      id,
      digest: this.key("answer", `${id}:${answer.toLowerCase()}`),
      expiresAt: now + 120000,
    });
    const result = await this.redis.eval(
      "return redis.call('SET',KEYS[1],ARGV[1],'PX',120000)",
      1,
      key,
      value
    );
    if (result !== "OK") throw new Error("Captcha storage failed");
  }

  async consumeCaptcha(
    context: string,
    purpose: string,
    id: string,
    answer: string,
    now: number
  ): Promise<boolean> {
    return (
      (await this.redis.eval(
        captchaConsumeScript,
        1,
        this.key("captcha", `${context}:${purpose}`),
        id,
        this.key("answer", `${id}:${answer.toLowerCase()}`),
        now
      )) === 1
    );
  }
}
