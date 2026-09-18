/** The example consumes the installed package, with NodeNext-style .js imports in TS source. */
export default {
  serverExternalPackages: ["pg", "drizzle-orm"],
  experimental: { extensionAlias: { ".js": [".ts", ".tsx", ".js"] } },
};
