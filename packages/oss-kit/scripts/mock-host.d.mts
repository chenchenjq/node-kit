import type { OssStore } from "oss-kit";
import type { OssTransportFactory } from "oss-kit/server";
export function memoryStore(): OssStore;
export function mockOss(): { objects: Map<string, Buffer>; factory: OssTransportFactory };
