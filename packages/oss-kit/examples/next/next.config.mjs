// Externalize only the Node SDK; React components must keep Next's React module/SSR handling.
export default { poweredByHeader: false, serverExternalPackages: ["ali-oss"] };
