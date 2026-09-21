import net from "node:net";
import dns from "node:dns";
import tls from "node:tls";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";

/**
 * 断网守卫（测试用）：拦截除本机回环/显式白名单之外的所有出站连接与 DNS 查询，
 * 并把尝试记录到 ADDR_OFFLINE_LOG。verify-pack 用它证明“初始化后断网仍可解析”。
 */
const allowed = new Set(["localhost", "127.0.0.1", "::1", process.env.ADDR_TEST_HOST].filter(Boolean));

function permit(host) {
  const name = String(host ?? "localhost").replace(/^\[|\]$/g, "").toLowerCase();
  if (allowed.has(name)) return;
  appendFileSync(process.env.ADDR_OFFLINE_LOG, JSON.stringify({ pid: process.pid, host: name }) + "\n");
  throw new Error("ADDR_EXTERNAL_NETWORK_BLOCKED");
}

function inspect(args) {
  const normalized = Array.isArray(args[0]) ? args[0] : args;
  const first = normalized[0];
  if (typeof first === "object" && first !== null) {
    if (!first.path) permit(first.host);
  } else if (!(typeof first === "string" && first.startsWith("/"))) {
    permit(typeof normalized[1] === "string" ? normalized[1] : "localhost");
  }
}

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  inspect(args);
  return Reflect.apply(connect, this, args);
};
const tlsConnect = tls.connect;
tls.connect = function (...args) {
  inspect(args);
  return Reflect.apply(tlsConnect, this, args);
};
for (const target of [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype]) {
  for (const key of Object.getOwnPropertyNames(target)) {
    if (!/^(lookup|lookupService|reverse|resolve.*)$/.test(key) || typeof target[key] !== "function") continue;
    const original = target[key];
    target[key] = function (host, ...args) {
      permit(host);
      return Reflect.apply(original, this, [host, ...args]);
    };
  }
}
const originalFetch = globalThis.fetch;
globalThis.fetch = function (input, init) {
  permit(new URL(typeof input === "string" || input instanceof URL ? input : input.url).hostname);
  return originalFetch(input, init);
};
syncBuiltinESMExports();
