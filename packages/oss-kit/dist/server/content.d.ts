import { Readable } from "node:stream";
import type { Strategy } from "../types.js";
export declare function collectBody(body: Buffer | Readable, limit: number, timeout: number): Promise<Buffer>;
export declare function validateContent(data: Buffer, originalName: string, suppliedMime: string, strategy: Strategy): Promise<string>;
