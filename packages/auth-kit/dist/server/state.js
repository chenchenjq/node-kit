import { createHmac, randomUUID } from "node:crypto";
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
    redis;
    appId;
    secret;
    constructor(redis, appId, secret) {
        this.redis = redis;
        this.appId = appId;
        this.secret = secret;
    }
    key(scope, value) {
        return `auth-kit:${this.appId}:${scope}:${createHmac("sha256", this.secret).update(value).digest("hex")}`;
    }
    async now() {
        const value = await this.redis.eval("local t=redis.call('TIME'); return tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)", 0);
        if (typeof value !== "number" || !Number.isSafeInteger(value))
            throw new Error("Invalid Redis time");
        return value;
    }
    async limit(scope, value, now, window, limit, interval = 0, pending = false) {
        const result = await this.redis.eval(windowScript, 1, this.key(scope, value), now, window, limit, interval, randomUUID(), pending ? "pending" : "");
        if (!Array.isArray(result) ||
            result.length !== 2 ||
            !Number.isSafeInteger(result[1]))
            throw new Error("Invalid Redis response");
        return { allowed: result[0] === 1, retryAt: result[1] };
    }
    reserveSend(phone, now, pending = false) {
        return this.limit("sms", phone, now, 300000, 3, 60000, pending);
    }
    /** Conservative completion-time fence: provider/database latency cannot shorten the next cooldown. */
    async finishSend(phone, now) {
        const result = await this.redis.eval(`
      redis.call('ZREM',KEYS[1],'pending')
      local last=redis.call('ZRANGE',KEYS[1],-1,-1)
      local member=last[1] or ARGV[2]
      redis.call('ZADD',KEYS[1],ARGV[1],member); redis.call('PEXPIRE',KEYS[1],300000)
      local retry=tonumber(ARGV[1])+60000
      if redis.call('ZCARD',KEYS[1])>=3 then
        local first=redis.call('ZRANGE',KEYS[1],0,0,'WITHSCORES'); retry=math.max(retry,tonumber(first[2])+300000)
      end
      return retry`, 1, this.key("sms", phone), now, randomUUID());
        if (typeof result !== "number")
            throw new Error("Invalid Redis response");
        return result;
    }
    async clearDelivery(identifier) {
        await this.redis.eval("return redis.call('DEL',KEYS[1])", 1, this.key("delivery", identifier));
    }
    async acceptDelivery(identifier, expiresAt) {
        const now = await this.now();
        if (expiresAt <= now)
            throw new Error("Delivery expired");
        if ((await this.redis.eval("return redis.call('SET',KEYS[1],ARGV[1],'PX',ARGV[2])", 1, this.key("delivery", identifier), String(expiresAt), expiresAt - now)) !== "OK")
            throw new Error("Delivery status unavailable");
    }
    /** Stores only native issuance expiry, never SMS code/answer/hash or verification attempt counts. */
    async deliveryAccepted(identifier, expiresAt) {
        return ((await this.redis.eval("return redis.call('GET',KEYS[1])", 1, this.key("delivery", identifier))) === String(expiresAt));
    }
    async saveCaptcha(context, purpose, id, answer, now) {
        const key = this.key("captcha", `${context}:${purpose}`);
        const value = JSON.stringify({
            id,
            digest: this.key("answer", `${id}:${answer.toLowerCase()}`),
            expiresAt: now + 120000,
        });
        const result = await this.redis.eval("return redis.call('SET',KEYS[1],ARGV[1],'PX',120000)", 1, key, value);
        if (result !== "OK")
            throw new Error("Captcha storage failed");
    }
    async consumeCaptcha(context, purpose, id, answer, now) {
        return ((await this.redis.eval(captchaConsumeScript, 1, this.key("captcha", `${context}:${purpose}`), id, this.key("answer", `${id}:${answer.toLowerCase()}`), now)) === 1);
    }
}
