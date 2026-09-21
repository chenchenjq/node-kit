type ParsedHttpsOrigin = Readonly<{ authority: string }>;
const maximumProviderEndpointLength = 2_048;

function validAuthoritySyntax(authority: string): boolean {
  if (authority.length === 0 || /[\s\\@%]/u.test(authority)) return false;
  if (authority.startsWith("[")) {
    const closing = authority.indexOf("]");
    if (closing <= 1 || authority.indexOf("]", closing + 1) !== -1) return false;
    const suffix = authority.slice(closing + 1);
    return suffix.length === 0 || /^:[0-9]{1,5}$/u.test(suffix);
  }
  const firstColon = authority.indexOf(":");
  if (firstColon === -1) return true;
  return firstColon === authority.lastIndexOf(":")
    && firstColon > 0
    && /^:[0-9]{1,5}$/u.test(authority.slice(firstColon));
}

function parseHttpsOrigin(value: string): ParsedHttpsOrigin | undefined {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || value.length > maximumProviderEndpointLength) return undefined;
  // Check the raw spelling before WHATWG URL normalization. Otherwise empty
  // userinfo and dot-segment paths can disappear and masquerade as an origin.
  const lexical = /^https:\/\/([^/?#\\]+)\/?$/iu.exec(value);
  const authority = lexical?.[1];
  if (authority === undefined || !validAuthoritySyntax(authority)) return undefined;
  try {
    const endpoint = new URL(value);
    if (endpoint.protocol !== "https:" || endpoint.username.length > 0 || endpoint.password.length > 0 ||
        endpoint.pathname !== "/" || endpoint.search.length > 0 || endpoint.hash.length > 0 || endpoint.hostname.length === 0) {
      return undefined;
    }
    return { authority: endpoint.host };
  } catch {
    return undefined;
  }
}

/** Validates the credential-free HTTPS-origin representation stored by sms-kit. */
export function isProviderEndpointOrigin(value: string): boolean {
  return parseHttpsOrigin(value) !== undefined;
}

/**
 * Converts a stored HTTPS origin to the Aliyun SDK authority. A bare authority
 * remains accepted only for compatibility with direct provider compositions.
 */
export function aliyunSdkEndpointAuthority(value: string): string {
  const parsed = parseHttpsOrigin(value) ?? (value.includes("://") ? undefined : parseHttpsOrigin(`https://${value}`));
  if (parsed === undefined) throw new TypeError("invalid Aliyun endpoint");
  return parsed.authority;
}
