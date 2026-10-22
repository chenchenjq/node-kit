import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { Agent, fetch as undiciFetch } from "undici";
import { AiKitError } from "./errors.js";
async function withSignal<T>(
  work: Promise<T>,
  signal: AbortSignal | null | undefined,
): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) throw new AiKitError("CANCELLED");
  let remove = () => {};
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        const cancel = () => reject(new AiKitError("CANCELLED"));
        signal.addEventListener("abort", cancel, { once: true });
        remove = () => signal.removeEventListener("abort", cancel);
      }),
    ]);
  } finally {
    remove();
  }
}
export interface TransportDependencies {
  lookup?(hostname: string): Promise<{ address: string; family: number }[]>;
  fetch?: typeof globalThis.fetch;
}
export function isPublicAddress(address: string): boolean {
  try {
    let ip = ipaddr.parse(address);
    if (ip.kind() === "ipv6" && (ip as ipaddr.IPv6).isIPv4MappedAddress())
      ip = (ip as ipaddr.IPv6).toIPv4Address();
    return ip.range() === "unicast";
  } catch {
    return false;
  }
}
export function validateBaseURL(value: string): URL {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.hostname.endsWith(".") ||
      !url.hostname
    )
      throw new Error();
    if (isIP(host) && !isPublicAddress(host)) throw new Error();
    if (
      url.pathname.includes("%") ||
      /\/\/|\/v1\/v1(?:\/|$)/.test(url.pathname) ||
      /\/(chat\/completions|responses|messages|models)\/?$/.test(url.pathname)
    )
      throw new Error();
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url;
  } catch {
    throw new AiKitError("UNSAFE_URL");
  }
}
export interface SafeTransport {
  fetch: typeof globalThis.fetch;
  close(): Promise<void>;
}
/** DNS is checked once, then pinned in the TLS connection lookup; redirect handling is disabled. */
export async function createSafeTransport(
  baseURL: string,
  allowURL: (url: URL) => Promise<boolean>,
  deps: TransportDependencies = {},
  maxResponseBytes = 2_000_000,
): Promise<SafeTransport> {
  const base = validateBaseURL(baseURL);
  let allowed = false;
  try {
    allowed = await allowURL(new URL(base));
  } catch {
    /* fail closed */
  }
  if (!allowed) throw new AiKitError("UNSAFE_URL");
  const hostname = base.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await (
        deps.lookup ??
        ((host) => dnsLookup(host, { all: true, verbatim: true }))
      )(hostname);
  if (!addresses.length || addresses.some((x) => !isPublicAddress(x.address)))
    throw new AiKitError("UNSAFE_URL");
  const pinned = addresses[0]!;
  const agent = new Agent({
    connect: {
      lookup(host, options, callback) {
        if (host !== hostname) {
          callback(new Error("Unverified target"), "", 4);
          return;
        }
        if (typeof options === "object" && options.all)
          (
            callback as unknown as (
              e: null,
              ips: { address: string; family: number }[],
            ) => void
          )(null, addresses);
        else callback(null, pinned.address, pinned.family);
      },
    },
  });
  const prefix = base.pathname.replace(/\/$/, "");
  let closed = false;
  return {
    async fetch(input, init) {
      const raw = input instanceof Request ? input.url : String(input),
        url = new URL(raw);
      if (
        closed ||
        url.origin !== base.origin ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !["/chat/completions", "/responses", "/messages", "/models"].some(
          (path) => url.pathname === `${prefix}${path}`,
        )
      )
        throw new AiKitError("UNSAFE_URL");
      const signal =
        init?.signal ?? (input instanceof Request ? input.signal : undefined);
      if (signal?.aborted) throw new AiKitError("CANCELLED");
      if (!(await withSignal(allowURL(new URL(url)), signal)))
        throw new AiKitError("UNSAFE_URL");
      if (signal?.aborted) throw new AiKitError("CANCELLED");
      const response = deps.fetch
        ? await deps.fetch(input, { ...init, redirect: "error" })
        : ((await undiciFetch(raw, {
            ...init,
            redirect: "error",
            dispatcher: agent,
          } as Parameters<typeof undiciFetch>[1])) as unknown as Response);
      if (
        (response.status >= 300 && response.status < 400) ||
        response.redirected ||
        (response.url && new URL(response.url).origin !== base.origin)
      ) {
        await response.body?.cancel();
        throw new AiKitError("UNSAFE_URL");
      }
      if (Number(response.headers.get("content-length")) > maxResponseBytes) {
        await response.body?.cancel();
        throw new AiKitError("OUTPUT_LIMIT");
      }
      if (!response.body) return response;
      const reader = response.body.getReader();
      let received = 0;
      const abort = () => {
        void reader.cancel().catch(() => {});
      };
      const cleanup = () => signal?.removeEventListener("abort", abort);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const part = await reader.read();
            if (part.done) {
              cleanup();
              controller.close();
              return;
            }
            received += part.value.byteLength;
            if (received > maxResponseBytes) {
              cleanup();
              await reader.cancel();
              controller.error(new AiKitError("OUTPUT_LIMIT"));
              return;
            }
            controller.enqueue(part.value);
          } catch (error) {
            cleanup();
            controller.error(error);
          }
        },
        async cancel(reason) {
          cleanup();
          await reader.cancel(reason);
        },
      });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
    async close() {
      closed = true;
      await agent.destroy();
    },
  };
}
