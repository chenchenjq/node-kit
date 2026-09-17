import { expect, it, vi } from "vitest";

import { AreaClientError, createAreaClient } from "../src/client/index.js";

it("forwards cancellation and preserves a structured selection rejection", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({data: {accepted: false, reason: "NAVIGATION_ONLY"}}));
  const client = createAreaClient({baseURL: "https://example.test/api/area-kit", fetch: fetcher});
  const controller = new AbortController();

  const result = await client.validateSelection({pathCodes: ["01", "0101"], targetLevel: 2}, controller.signal);

  expect(result.accepted).toBe(false);
  expect(fetcher.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
});

it("normalizes a trailing base URL slash and maps every method to its explicit route", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({data: {ok: true}}));
  const client = createAreaClient({baseURL: "https://example.test/api/area-kit/", fetch: fetcher});
  const signal = new AbortController().signal;

  await client.getDataset({datasetId: "d"}, signal);
  await client.listDatasets({limit: 10}, signal);
  await client.listProvinces({versionCode: "v"}, signal);
  await client.listChildren({parentCode: "01"}, signal);
  await client.listRegions({ancestorCode: "01", selectableOnly: true}, signal);
  await client.getRegion({code: "0101"}, signal);
  await client.getRegions({codes: ["01", "0101"]}, signal);
  await client.getPath({code: "0101"}, signal);
  await client.search({keyword: "north"}, signal);
  await client.getTree({depth: 2}, signal);
  await client.validateSelection({pathCodes: ["01"]}, signal);
  await client.updatePresentation({code: "01", revision: 1, patch: {enabled: false}}, signal);
  await client.getDatasetReport({datasetId: "d"}, signal);

  const requests = fetcher.mock.calls.map(([url, init]) => ({url: String(url), method: init?.method ?? "GET", body: init?.body}));
  expect(requests.map(request => request.url)).toEqual([
    "https://example.test/api/area-kit/dataset?datasetId=d",
    "https://example.test/api/area-kit/datasets?limit=10",
    "https://example.test/api/area-kit/provinces?versionCode=v",
    "https://example.test/api/area-kit/children?parentCode=01",
    "https://example.test/api/area-kit/regions?ancestorCode=01&selectableOnly=true",
    "https://example.test/api/area-kit/region?code=0101",
    "https://example.test/api/area-kit/batch?codes=01&codes=0101",
    "https://example.test/api/area-kit/path?code=0101",
    "https://example.test/api/area-kit/search?keyword=north",
    "https://example.test/api/area-kit/tree?depth=2",
    "https://example.test/api/area-kit/validate",
    "https://example.test/api/area-kit/admin/presentation",
    "https://example.test/api/area-kit/admin/report?datasetId=d",
  ]);
  expect(requests.map(request => request.method)).toEqual(["GET", "GET", "GET", "GET", "GET", "GET", "GET", "GET", "GET", "GET", "POST", "PATCH", "GET"]);
  expect(requests[10]?.body).toBe(JSON.stringify({pathCodes: ["01"]}));
  expect(requests[11]?.body).toBe(JSON.stringify({code: "01", revision: 1, patch: {enabled: false}}));
  expect(fetcher.mock.calls.every(([, init]) => init?.signal === signal)).toBe(true);
});

it("only exposes sanitized allowlisted errors and keeps abort failures intact", async () => {
  const malformed = createAreaClient({baseURL: "https://example.test", fetch: async () => Response.json({error: {code: "INTERNAL", message: "secret"}}, {status: 500})});
  await expect(malformed.getDataset()).rejects.toEqual(new AreaClientError("QUERY_FAILED"));

  const aborted = new DOMException("aborted", "AbortError");
  const abortClient = createAreaClient({baseURL: "https://example.test", fetch: async () => { throw aborted; }});
  await expect(abortClient.getDataset()).rejects.toBe(aborted);
});

it("preserves an AbortError raised while decoding a response body", async () => {
  const aborted = new DOMException("aborted", "AbortError");
  const client = createAreaClient({baseURL: "https://example.test", fetch: async () => ({ok: true, json: async () => { throw aborted; }} as unknown as Response)});

  await expect(client.getDataset()).rejects.toBe(aborted);
});

it("encodes a root parent as an explicit empty query value", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({data: {items: []}}));
  const client = createAreaClient({baseURL: "https://example.test/api/area-kit", fetch: fetcher});

  await client.listRegions({parentCode: null});
  await client.search({keyword: "north", parentCode: null});

  expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
    "https://example.test/api/area-kit/regions?parentCode=",
    "https://example.test/api/area-kit/search?keyword=north&parentCode=",
  ]);
});
