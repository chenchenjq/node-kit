import net from 'node:net';
import dns from 'node:dns';
import tls from 'node:tls';
import {appendFileSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const allowed=new Set(['localhost','127.0.0.1','::1',process.env.AREA_TEST_DB_IP].filter(Boolean));
function permit(host) {
  const name=String(host??'localhost').replace(/^\[|\]$/g,'').toLowerCase();
  if(allowed.has(name)) return;
  appendFileSync(process.env.AREA_OFFLINE_LOG,JSON.stringify({pid:process.pid,host:name})+'\n');
  throw new Error('AREA_EXTERNAL_NETWORK_BLOCKED');
}
function inspect(args) {
  const normalized=Array.isArray(args[0])?args[0]:args,first=normalized[0];
  if(typeof first==='object'&&first!==null) {if(!first.path) permit(first.host);}
  else if(!(typeof first==='string'&&first.startsWith('/'))) permit(typeof normalized[1]==='string'?normalized[1]:'localhost');
}
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){inspect(args);return Reflect.apply(connect,this,args);};
const tlsConnect=tls.connect;
tls.connect=function(...args){inspect(args);return Reflect.apply(tlsConnect,this,args);};
for(const target of [dns,dns.promises,dns.Resolver.prototype,dns.promises.Resolver.prototype]) {
  for(const key of Object.getOwnPropertyNames(target)) {
    if(!/^(lookup|lookupService|reverse|resolve.*)$/.test(key)||typeof target[key]!=='function') continue;
    const original=target[key];target[key]=function(host,...args){permit(host);return Reflect.apply(original,this,[host,...args]);};
  }
}
const originalFetch=globalThis.fetch;
globalThis.fetch=function(input,init){permit(new URL(typeof input==='string'||input instanceof URL?input:input.url).hostname);return originalFetch(input,init);};
syncBuiltinESMExports();
