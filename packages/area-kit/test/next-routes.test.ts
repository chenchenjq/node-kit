import { afterEach, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { createAreaHost, getAreaHost, installAreaHost } from "../examples/next/lib/host.js";
import { AreaKitError } from "area-kit/server";
import { GET, PATCH, runtime as areaRuntime } from "../examples/next/app/api/area-kit/[...path]/route.js";
import { POST, runtime as submitRuntime } from "../examples/next/app/api/address-selection/route.js";
import { selectionRejectionError } from "../examples/next/lib/submission.js";

const key = Symbol.for("area-kit.next.host");
afterEach(() => { Reflect.deleteProperty(globalThis, key); });
const origin = "https://example.test";
function fixture() {
  const connect = vi.fn(async () => { throw new Error("must not connect"); });
  const ctx = {identity: "trusted"};
  const options = {pool: {connect} as unknown as Pool, authorize: vi.fn(async () => true),
    authenticate: vi.fn(async () => ctx), protectRequest: vi.fn(async () => {}), previewPolicy: () => ({}),
    submissionPolicy: () => ({targetLevel: 3 as const, policy: {}, versionPolicy: "active-only" as const}), persist: vi.fn(async () => {}), origin};
  const host = createAreaHost(options);
  return {host, options, connect, ctx};
}
function post(body: unknown, headers: Record<string,string> = {}) {
  return new Request(`${origin}/api/address-selection`, {method: "POST", headers: {origin, "content-type": "application/json", ...headers}, body: JSON.stringify(body)});
}

it("constructs without connecting and returns explicit configuration errors until installed", async () => {
  const {connect} = fixture();
  expect(connect).not.toHaveBeenCalled();
  expect(() => getAreaHost()).toThrowError(expect.objectContaining({code: "INVALID_CONFIG"}));
  for (const response of [await GET(new Request(`${origin}/api/area-kit/dataset`), {params: Promise.resolve({path: ["dataset"]})}),
    await POST(post({datasetId: "d", pathCodes: ["01"]}))]) {
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({error: {code: "INVALID_CONFIG"}});
  }
  expect(areaRuntime).toBe("nodejs"); expect(submitRuntime).toBe("nodejs");
});

it("awaits promised route params and binds only the installed host's authenticated context", async () => {
  const {host, options, ctx} = fixture();
  const getDataset = vi.spyOn(host.kit, "getDataset").mockResolvedValue({datasetId: "d"} as never);
  installAreaHost(host);
  const req = new Request(`${origin}/api/area-kit/dataset`);
  const response = await GET(req, {params: Promise.resolve({path: ["dataset"]})});
  expect(await response.json()).toEqual({data: {datasetId: "d"}});
  expect(getDataset).toHaveBeenCalledWith(ctx, {});
  expect(options.protectRequest).toHaveBeenCalledWith(req, ctx);
  expect(() => getAreaHost().kit.getDataset({identity: "forged"})).toThrowError(expect.objectContaining({code: "FORBIDDEN"}));
  const update = vi.spyOn(host.kit, "updatePresentation");
  const denied = await PATCH(new Request(`${origin}/api/area-kit/admin/presentation`, {method: "PATCH", headers: {origin: "https://evil.test"}}), {params: Promise.resolve({path: ["admin", "presentation"]})});
  expect(denied.status).toBe(403); expect(update).not.toHaveBeenCalled();
});

it("strictly parses submission JSON and rejects frontend context, role, and policy injection", async () => {
  const {host} = fixture();
  const submit = vi.spyOn(host, "submit").mockResolvedValue({code: "01", accepted: true} as never);
  installAreaHost(host);
  for (const extra of [{ctx: {}}, {role: "admin"}, {policy: {}}, {versionPolicy: "specified-ready"}]) {
    const response = await POST(post({datasetId: "d", pathCodes: ["01"], ...extra}));
    expect(response.status).toBe(400);
  }
  expect((await POST(post({pathCodes: ["01"]}, {"content-type": "text/plain"}))).status).toBe(400);
  expect((await POST(new Request(`${origin}/api/address-selection`, {method: "POST", headers: {"content-type": "application/json"}, body: "{"}))).status).toBe(400);
  expect((await POST(post({pathCodes: ["x".repeat(65_536)]}))).status).toBe(400);
  expect((await POST(new Request(`${origin}/api/address-selection?role=admin`, {method: "POST", headers: {"content-type": "application/json"}, body: "{}"}))).status).toBe(400);
  expect((await POST(new Request(`${origin}/api/address-selection`))).status).toBe(400);
  expect(submit).not.toHaveBeenCalled();
  const req = post({datasetId: "d", pathCodes: ["01"], targetLevel: 1});
  expect((await POST(req)).status).toBe(200);
  expect(submit).toHaveBeenCalledWith(req, {datasetId: "d", pathCodes: ["01"], targetLevel: 1});
});

it("protects actual submissions before connecting and returns structured reasons without leaking errors", async () => {
  const {host, options, connect} = fixture();
  options.protectRequest.mockRejectedValueOnce(new AreaKitError("FORBIDDEN"));
  installAreaHost(host);
  expect((await POST(post({datasetId: "d", pathCodes: ["01"]}))).status).toBe(403);
  expect((await POST(post({datasetId: "d", pathCodes: ["01"]}, {origin: "https://evil.test"}))).status).toBe(403);
  expect(connect).not.toHaveBeenCalled();
  const submit = vi.spyOn(host, "submit").mockRejectedValue(selectionRejectionError("DATASET_NOT_ACCEPTED"));
  installAreaHost(host);
  expect(await (await POST(post({datasetId: "d", pathCodes: ["01"]}))).json()).toMatchObject({error: {code: "VERSION_UNAVAILABLE", reason: "DATASET_NOT_ACCEPTED"}});
  submit.mockRejectedValue(new Error("postgres://secret"));
  expect(await (await POST(post({datasetId: "d", pathCodes: ["01"]}))).json()).toEqual({error: {code: "QUERY_FAILED", message: "区域查询失败"}});
});

it.each([
  ["NOT_INITIALIZED", "NOT_INITIALIZED"], ["UNKNOWN_CODE", "UNKNOWN_CODE"], ["VERSION_UNAVAILABLE", "VERSION_UNAVAILABLE"],
  ["PARENT_MISMATCH", "PARENT_MISMATCH"], ["NOT_SELECTABLE", "NOT_SELECTABLE"], ["DATASET_NOT_ACCEPTED", "VERSION_UNAVAILABLE"],
  ["NAVIGATION_ONLY", "TARGET_LEVEL_NOT_REACHED"], ["TARGET_LEVEL_EXCEEDED", "TARGET_LEVEL_NOT_REACHED"],
  ["TARGET_LEVEL_NOT_REACHED", "TARGET_LEVEL_NOT_REACHED"], ["TARGET_REACHED", "INVALID_CONFIG"],
  ["GROUP_ENDPOINT_EXCEPTION", "INVALID_CONFIG"], ["EARLY_TERMINATION_ACCEPTED", "INVALID_CONFIG"],
] as const)("maps selection rejection %s to %s while preserving its reason", (reason, code) => {
  expect(selectionRejectionError(reason).toJSON()).toMatchObject({code, reason});
});
