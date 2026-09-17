import {expect, it} from "vitest";
import {AreaClientError} from "../src/client/index.js";
import {resolveHistoricalArea} from "../src/react/history.js";
import type {AreaClient} from "../src/client/contracts.js";
import {syntheticDataset, syntheticRegion} from "./fixtures/factory.js";

const value={datasetId:"00000000-0000-4000-8000-000000000001",code:"01",pathNames:["合成旧省"]};

it("does not swallow a query failure as snapshot fallback",async()=>{
  const client:Pick<AreaClient,"getPath"|"getDataset">={
    getPath:async()=>{throw new AreaClientError("QUERY_FAILED");},
    getDataset:async()=>{throw new Error("Unexpected call");},
  };
  await expect(resolveHistoricalArea(client,value)).rejects.toMatchObject({code:"QUERY_FAILED"});
});

it("uses the dataset path and keeps disabled status distinct",async()=>{
  const node=syntheticRegion({effectiveEnabled:false});
  const client:Pick<AreaClient,"getPath"|"getDataset">={
    getPath:async()=>({datasetId:value.datasetId,versionCode:"v1",nodes:[node],pathCodes:[node.code],pathNames:["当前省"]}),
    getDataset:async()=>syntheticDataset({isActive:true}),
  };
  await expect(resolveHistoricalArea(client,value)).resolves.toEqual({pathNames:["当前省"],source:"dataset",status:"disabled"});
});

it("uses the explicit snapshot only for an unavailable historical record",async()=>{
  const client:Pick<AreaClient,"getPath"|"getDataset">={
    getPath:async()=>{throw new AreaClientError("VERSION_UNAVAILABLE");},
    getDataset:async()=>{throw new Error("Unexpected call");},
  };
  await expect(resolveHistoricalArea(client,value)).resolves.toEqual({pathNames:["合成旧省"],source:"snapshot",status:"unverified"});
  await expect(resolveHistoricalArea(client,{datasetId:value.datasetId,code:value.code})).resolves.toEqual({pathNames:[],source:"snapshot",status:"unverified"});
});
