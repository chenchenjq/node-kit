import {AreaClientError} from "../client/index.js";
import type {AreaClient} from "../client/contracts.js";
import type {AreaValue} from "../types.js";

export interface HistoricalArea {
  pathNames: string[];
  source: "dataset" | "snapshot";
  status: "current" | "historical" | "disabled" | "unverified";
}

/** Resolves a stored area value without treating transient query failures as history. */
export async function resolveHistoricalArea(client:Pick<AreaClient,"getPath"|"getDataset">,value:AreaValue,
  signal?:AbortSignal):Promise<HistoricalArea> {
  try {
    const path=await client.getPath({datasetId:value.datasetId,code:value.code},signal);
    const dataset=await client.getDataset({datasetId:value.datasetId},signal);
    return {pathNames:path.pathNames,source:"dataset",
      status:path.nodes.some(node=>!node.effectiveEnabled) ? "disabled" : dataset.isActive ? "current" : "historical"};
  } catch(error) {
    if (!(error instanceof AreaClientError) || !["UNKNOWN_CODE","VERSION_UNAVAILABLE"].includes(error.code)) throw error;
    return {pathNames:value.pathNames ?? [],source:"snapshot",status:"unverified"};
  }
}
