// Next must reject this entry during compilation, before a client bundle can execute it.
import "server-only";

throw new Error("addr-parse-kit server entry cannot run in a browser");

// Keep an explicit empty export table so esbuild rejects named server imports.
export {};
