import { expect, it, vi } from "vitest";

import { handleAreaRequest, readAreaJsonBody, type AreaHost } from "../examples/next/lib/http.js";

type TestHost = Omit<AreaHost<{trusted: true}>, "kit" | "authenticate" | "protectRequest" | "previewPolicy" | "submissionPolicy"> & {
  kit: Record<string, ReturnType<typeof vi.fn>>;
  authenticate: ReturnType<typeof vi.fn>;
  protectRequest: ReturnType<typeof vi.fn>;
  previewPolicy: ReturnType<typeof vi.fn>;
  submissionPolicy: ReturnType<typeof vi.fn>;
};

function host(): TestHost {
  const kit = {
    getDataset: vi.fn(async () => ({datasetId: "d"})), listDatasets: vi.fn(), listProvinces: vi.fn(), listChildren: vi.fn(),
    listRegions: vi.fn(async () => ({items: []})), getRegion: vi.fn(), getRegions: vi.fn(), getPath: vi.fn(), search: vi.fn(), getTree: vi.fn(),
    validateSelection: vi.fn(async () => ({accepted: false, reason: "NAVIGATION_ONLY"})), updatePresentation: vi.fn(async () => ({code: "01"})),
    getDatasetReport: vi.fn(),
  };
  return {kit, authorize: async () => true, authenticate: vi.fn(async () => ({trusted: true})), protectRequest: vi.fn(async () => undefined),
    previewPolicy: vi.fn(() => ({allowEarlyTermination: false})), submissionPolicy: vi.fn(() => ({targetLevel: 3, policy: {}, versionPolicy: "active-only"})),
    origin: "https://app.example.test"};
}

async function response(request: Request, path: readonly string[], areaHost = host()): Promise<{body: unknown; response: Response; host: typeof areaHost}> {
  const result = await handleAreaRequest(request, path, areaHost as unknown as AreaHost<{trusted: true}>);
  return {body: await result.json(), response: result, host: areaHost};
}

it("authenticates and protects reads before forwarding strict parsed filters", async () => {
  const areaHost = host();
  const result = await response(new Request("https://api.example.test/regions?ancestorCode=01&level=2&limit=5&selectableOnly=true"), ["regions"], areaHost);

  expect(result.response.status).toBe(200);
  expect(result.response.headers.get("cache-control")).toBe("no-store");
  expect(result.body).toEqual({data: {items: []}});
  expect(areaHost.kit.listRegions).toHaveBeenCalledWith({trusted: true}, {ancestorCode: "01", level: 2, limit: 5, selectableOnly: true});
  expect(areaHost.authenticate).toHaveBeenCalledBefore(areaHost.protectRequest as ReturnType<typeof vi.fn>);
});

it("forwards every supported child filter and decodes an explicit root parent", async () => {
  const areaHost = host();
  areaHost.kit.listChildren!.mockResolvedValue({items: []});
  areaHost.kit.listRegions!.mockResolvedValue({items: []});
  areaHost.kit.search!.mockResolvedValue({items: []});

  await response(new Request("https://api.example.test/children?parentCode=01&ancestorCode=00&level=2&selectableOnly=true"), ["children"], areaHost);
  await response(new Request("https://api.example.test/regions?parentCode="), ["regions"], areaHost);
  await response(new Request("https://api.example.test/search?keyword=north&parentCode="), ["search"], areaHost);

  expect(areaHost.kit.listChildren).toHaveBeenCalledWith({trusted: true}, {parentCode: "01", ancestorCode: "00", level: 2, selectableOnly: true});
  expect(areaHost.kit.listRegions).toHaveBeenCalledWith({trusted: true}, {parentCode: null});
  expect(areaHost.kit.search).toHaveBeenCalledWith({trusted: true}, {keyword: "north", parentCode: null});
});

it("rejects unknown or ambiguous query fields before any kit operation", async () => {
  const areaHost = host();
  const result = await response(new Request("https://api.example.test/regions?limit=1&limit=2&role=admin"), ["regions"], areaHost);

  expect(result.response.status).toBe(400);
  expect(result.body).toEqual({error: {code: "INVALID_ARGUMENT", message: "请求参数无效"}});
  expect(areaHost.kit.listRegions).not.toHaveBeenCalled();
});

it("uses repeated parameters for a batch and never comma-splits codes", async () => {
  const areaHost = host();
  areaHost.kit.getRegions!.mockResolvedValue({items: []});
  await response(new Request("https://api.example.test/batch?codes=01&codes=0101"), ["batch"], areaHost);
  expect(areaHost.kit.getRegions).toHaveBeenCalledWith({trusted: true}, {codes: ["01", "0101"]});
  const comma = host();
  await response(new Request("https://api.example.test/batch?codes=01,0101"), ["batch"], comma);
  expect(comma.kit.getRegions).toHaveBeenCalledWith({trusted: true}, {codes: ["01,0101"]});
});

it("rejects policy injection and supplies only trusted preview policy with specified-ready", async () => {
  const areaHost = host();
  const result = await response(new Request("https://api.example.test/validate", {method: "POST", headers: {"content-type": "application/json"},
    body: JSON.stringify({pathCodes: ["01"], targetLevel: 2, policy: {allowEarlyTermination: true}, versionPolicy: "active-only"})}), ["validate"], areaHost);
  expect(result.response.status).toBe(400);
  expect(areaHost.kit.validateSelection).not.toHaveBeenCalled();

  await response(new Request("https://api.example.test/validate", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({pathCodes: ["01"], targetLevel: 2})}), ["validate"], areaHost);
  expect(areaHost.kit.validateSelection).toHaveBeenCalledWith({trusted: true}, {pathCodes: ["01"], targetLevel: 2}, {policy: {allowEarlyTermination: false}, versionPolicy: "specified-ready"});
});

it("rejects mutation query injection before calling either mutation", async () => {
  const validateHost = host();
  const validate = await response(new Request("https://api.example.test/validate?role=admin", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({pathCodes: ["01"]})}), ["validate"], validateHost);
  expect(validate.response.status).toBe(400);
  expect(validateHost.kit.validateSelection).not.toHaveBeenCalled();

  const patchHost = host();
  const patch = await response(new Request("https://api.example.test/admin/presentation?policy=relaxed", {method: "PATCH", headers: {"origin": "https://app.example.test", "content-type": "application/json"}, body: JSON.stringify({code: "01", revision: 1, patch: {enabled: false}})}), ["admin", "presentation"], patchHost);
  expect(patch.response.status).toBe(400);
  expect(patchHost.kit.updatePresentation).not.toHaveBeenCalled();
});

it("requires same origin and request protection for a strict presentation patch", async () => {
  const areaHost = host();
  const denied = await response(new Request("https://api.example.test/admin/presentation", {method: "PATCH", headers: {"content-type": "application/json"}, body: JSON.stringify({code: "01", revision: 1, patch: {enabled: false}})}), ["admin", "presentation"], areaHost);
  expect(denied.response.status).toBe(403);
  expect(areaHost.kit.updatePresentation).not.toHaveBeenCalled();

  const accepted = await response(new Request("https://api.example.test/admin/presentation", {method: "PATCH", headers: {"origin": "https://app.example.test", "content-type": "application/json"}, body: JSON.stringify({code: "01", revision: 1, patch: {enabled: false}})}), ["admin", "presentation"], areaHost);
  expect(accepted.body).toEqual({data: {code: "01"}});
  expect(areaHost.kit.updatePresentation).toHaveBeenCalledWith({trusted: true}, {code: "01", revision: 1, patch: {enabled: false}});
});

it("enforces the streaming JSON size limit and sanitizes malformed JSON", async () => {
  const large = new Request("https://api.example.test", {method: "POST", body: "x".repeat(65_537)});
  await expect(readAreaJsonBody(large)).rejects.toMatchObject({code: "INVALID_ARGUMENT"});
  const malformed = await response(new Request("https://api.example.test/validate", {method: "POST", headers: {"content-type": "application/json"}, body: "{"}), ["validate"]);
  expect(malformed.response.status).toBe(400);
  expect(malformed.body).toEqual({error: {code: "INVALID_ARGUMENT", message: "请求参数无效"}});
});

it("returns only sanitized AreaKit errors and rejects undeclared routes", async () => {
  const areaHost = host();
  areaHost.kit.listRegions!.mockRejectedValue(new Error("postgres://secret"));
  const failed = await response(new Request("https://api.example.test/regions"), ["regions"], areaHost);
  expect(failed.response.status).toBe(500);
  expect(failed.body).toEqual({error: {code: "QUERY_FAILED", message: "区域查询失败"}});
  const absent = await response(new Request("https://api.example.test/import", {method: "POST"}), ["import"], host());
  expect(absent.response.status).toBe(400);
});
