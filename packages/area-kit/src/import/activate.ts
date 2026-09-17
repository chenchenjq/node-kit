import { AreaKitError } from "../errors.js";
import type { AreaStore } from "../server/ports.js";
import type { DatasetSummary } from "../types.js";

/** Activation is always an explicit, serialized store write after successful import. */
export async function activateDataset(store: AreaStore, datasetId: string): Promise<DatasetSummary> {
  if (typeof datasetId !== "string" || !datasetId.trim()) throw new AreaKitError("INVALID_ARGUMENT");
  return store.write(async view => {
    const dataset = await view.resolveDataset({datasetId});
    if (!dataset || dataset.status !== "ready" || dataset.report.passed !== true) throw new AreaKitError("VERSION_UNAVAILABLE");
    await view.setActive(datasetId);
    const {report: _report, progress: _progress, fileChecksums: _files, ...summary} = dataset;
    return {...summary,isActive:true};
  });
}
