import { createHash } from "node:crypto";
import { AreaKitError } from "../errors.js";

export const MCA_DELIVERY_REGION_SOURCE = "https://dmfw.mca.gov.cn/9095/xzqh/getList?code=&maxLevel=3";
export type DeliveryRegionLevel = "PROVINCE" | "CITY" | "COUNTY";
export type DeliveryRegionKind = "PROVINCE" | "PREFECTURE" | "COUNTY" | "DIRECT_ADMIN" | "GROUP";
export interface DeliveryRegion {
  code: string;
  parent_code: string | null;
  name: string;
  level: DeliveryRegionLevel;
  node_kind: DeliveryRegionKind;
}
export interface McaDeliveryRegionSnapshot {
  source: string;
  source_response_date: string;
  retrieved_at: string;
  source_tag: string | null;
  sha256: string;
  version: string;
  country_region_code: "CN";
  raw_response: string;
  regions: DeliveryRegion[];
}

interface McaNode { code: string; name: string | null; level: number; type: string; children: McaNode[] }
const MAINLAND_CODE_PREFIXES = new Set(Array.from({ length: 99 }, (_, index) => String(index + 1).padStart(2, "0"))
  .filter(code => !["71", "81", "82"].includes(code)));
const MUNICIPALITIES = new Set(["11", "12", "31", "50"]);
const COUNTY_TYPES = new Set(["市辖区", "县", "自治县", "旗", "自治旗", "林区", "特区"]);
const CITY_TYPES = new Set(["县级市"]);
const PREFECTURE_TYPES = new Set(["地级市", "地区", "自治州", "盟", "市辖区", "省直辖县级行政区划", "自治区直辖县级行政区划"]);
const API_DATE_FALLBACK = "undated";

function conflict(): never { throw new AreaKitError("IMPORT_CONFLICT"); }
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function node(value: unknown, expectedLevel: number): McaNode {
  if (!object(value) || typeof value.code !== "string" || !/^\d{12}$/u.test(value.code) ||
    typeof value.name !== "string" || !value.name.trim() || value.level !== expectedLevel ||
    typeof value.type !== "string" || !Array.isArray(value.children)) conflict();
  return value as unknown as McaNode;
}
function sixDigitCode(value: McaNode): string {
  const code = value.code.slice(0, 6);
  if (!/^\d{6}$/u.test(code) || !/^0{6}$/u.test(value.code.slice(6))) conflict();
  return code;
}
function apiDate(value: string | null | undefined): string {
  if (value === undefined || value === null) return API_DATE_FALLBACK;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) conflict();
  return new Date(timestamp).toISOString();
}

/** Map the official MCA county-level query tree to validated six-digit regions for OMS shipping addresses. */
export function mapMcaDeliveryRegions(
  payload: unknown,
  metadata: Readonly<{ retrieved_at?: string; http_date?: string | null; sha256?: string; raw_response?: string }> = {},
): McaDeliveryRegionSnapshot {
  if (!object(payload) || payload.status !== 200 || !object(payload.data)) conflict();
  const data = payload.data;
  if (data.code !== "00" || data.level !== 0 || !Array.isArray(data.children) ||
    !(payload.tag === null || typeof payload.tag === "string")) conflict();
  const provinces = (data.children as unknown[]).map(value => node(value, 1))
    .filter(value => MAINLAND_CODE_PREFIXES.has(value.code.slice(0, 2)));
  if (provinces.length !== 31 || new Set(provinces.map(value => sixDigitCode(value))).size !== provinces.length) conflict();

  const regions: DeliveryRegion[] = [];
  const seen = new Set<string>();
  function add(region: DeliveryRegion): void {
    if (!/^\d{6}$/u.test(region.code) || seen.has(region.code) ||
      region.level === "PROVINCE" !== (region.parent_code === null) ||
      (region.parent_code !== null && region.code.slice(0, 2) !== region.parent_code.slice(0, 2))) conflict();
    seen.add(region.code);
    regions.push(region);
  }
  for (const province of provinces) {
    const provinceCode = sixDigitCode(province);
    add({ code: provinceCode, parent_code: null, name: province.name!, level: "PROVINCE", node_kind: "PROVINCE" });
      const children = (province.children as unknown[]).map(value => {
      if (!object(value) || (value.level !== 2 && value.level !== 3)) conflict();
      return node(value, value.level);
    });
    const directCounties: McaNode[] = [];
    for (const child of children) {
      const childCode = sixDigitCode(child);
      if (child.level === 3) {
        directCounties.push(child);
        continue;
      }
      if (!PREFECTURE_TYPES.has(child.type)) conflict();
      const municipalityGroupCode = `${provinceCode.slice(0, 2)}0100`;
      const countyGroupCode = `${provinceCode.slice(0, 2)}9000`;
      const municipalityGroup = MUNICIPALITIES.has(provinceCode.slice(0, 2)) &&
        (childCode === municipalityGroupCode || child.name === "市辖区");
      const directCountyGroup = childCode === countyGroupCode ||
        child.name === "省直辖县级行政区划" || child.name === "自治区直辖县级行政区划";
      const isAddressGroup = municipalityGroup || directCountyGroup;
      const kind: DeliveryRegionKind = isAddressGroup ? "GROUP" : "PREFECTURE";
      const name = municipalityGroup ? province.name! : child.name!;
      if (child.children.length === 0) {
        add({ code: childCode, parent_code: provinceCode, name, level: "CITY", node_kind: kind });
        continue;
      }
      if (child.children.length > 0) {
        add({ code: childCode, parent_code: provinceCode, name, level: "CITY", node_kind: kind });
        for (const rawGrandchild of child.children) {
          const grandchild = node(rawGrandchild, 3);
          if (!COUNTY_TYPES.has(grandchild.type) && !CITY_TYPES.has(grandchild.type)) conflict();
          const isCountyLevelCity = CITY_TYPES.has(grandchild.type);
          add({ code: sixDigitCode(grandchild), parent_code: isCountyLevelCity && directCountyGroup ? provinceCode : childCode,
            name: grandchild.name!, level: isCountyLevelCity && directCountyGroup ? "CITY" : "COUNTY",
            node_kind: directCountyGroup ? "DIRECT_ADMIN" : "COUNTY" });
        }
        continue;
      }
    }

    // The four municipalities expose districts/counties directly. Keep the real city code used by
    // shipping addresses as a nonselectable parent, then expose the actual lower-level choices.
    if (MUNICIPALITIES.has(provinceCode.slice(0, 2)) && directCounties.length > 0) {
      const groupCode = `${provinceCode.slice(0, 2)}0100`;
      if (!seen.has(groupCode)) add({ code: groupCode, parent_code: provinceCode, name: province.name!, level: "CITY", node_kind: "GROUP" });
      for (const division of directCounties) {
        if (!COUNTY_TYPES.has(division.type)) conflict();
        add({ code: sixDigitCode(division), parent_code: groupCode, name: division.name!, level: "COUNTY", node_kind: "COUNTY" });
      }
      continue;
    }

    const directCountyRows = directCounties.filter(value => !CITY_TYPES.has(value.type));
    const directCityRows = directCounties.filter(value => CITY_TYPES.has(value.type));
    if (directCounties.some(value => !COUNTY_TYPES.has(value.type) && !CITY_TYPES.has(value.type))) conflict();
    if (directCountyRows.length > 0) {
      const groupCode = `${provinceCode.slice(0, 2)}9000`;
      if (!seen.has(groupCode)) add({ code: groupCode, parent_code: provinceCode, name: "省直辖县级行政区划", level: "CITY", node_kind: "GROUP" });
      for (const division of directCountyRows) {
        add({ code: sixDigitCode(division), parent_code: groupCode, name: division.name!, level: "COUNTY", node_kind: "DIRECT_ADMIN" });
      }
    }
    for (const division of directCityRows) {
      add({ code: sixDigitCode(division), parent_code: provinceCode, name: division.name!, level: "CITY", node_kind: "DIRECT_ADMIN" });
    }
  }
  regions.sort((left, right) => left.code.localeCompare(right.code));
  const retrievedAt = metadata.retrieved_at ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(retrievedAt))) conflict();
  const responseDate = apiDate(metadata.http_date);
  const sha256 = metadata.sha256 ?? createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  if (!/^[a-f0-9]{64}$/u.test(sha256)) conflict();
  return {
    source: MCA_DELIVERY_REGION_SOURCE,
    source_response_date: responseDate,
    retrieved_at: new Date(retrievedAt).toISOString(),
    source_tag: payload.tag as string | null,
    sha256,
    version: `mca-xzqh:${responseDate === API_DATE_FALLBACK ? "undated" : responseDate.slice(0, 10)}:${sha256.slice(0, 16)}`,
    country_region_code: "CN",
    raw_response: metadata.raw_response ?? JSON.stringify(payload),
    regions,
  };
}

/** Fetch and pin the response bytes so the resulting snapshot is reproducible even when MCA updates the endpoint. */
export async function fetchMcaDeliveryRegions(
  fetcher: typeof fetch = globalThis.fetch,
  now: () => Date = () => new Date(),
): Promise<McaDeliveryRegionSnapshot> {
  try {
    const response = await fetcher(MCA_DELIVERY_REGION_SOURCE, { headers: { accept: "application/json" } });
    if (!response.ok) return conflict();
    const text = await response.text();
    const payload: unknown = JSON.parse(text);
    return mapMcaDeliveryRegions(payload, {
      retrieved_at: now().toISOString(),
      http_date: response.headers.get("date"),
      sha256: createHash("sha256").update(text).digest("hex"),
      raw_response: text,
    });
  } catch {
    return conflict();
  }
}
