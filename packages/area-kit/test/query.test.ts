import { expect, it, vi } from "vitest";
import * as server from "../src/server/index.js";
import type { AreaStore, ReadView, DatasetRecord } from "../src/server/ports.js";

it("denies reads before storage and sanitizes authorization failures", async () => {
  const read = vi.fn(), write = vi.fn();
  const store: AreaStore = {read,write};
  expect(server).toHaveProperty("createAreaKit");
  const kit = server.createAreaKit({store,authorize:async()=>false});
  await expect(kit.listProvinces(null)).rejects.toMatchObject({code:"FORBIDDEN"});
  expect(read).not.toHaveBeenCalled();
  const failed = server.createAreaKit({store,authorize:async()=>{throw new Error("secret");}});
  await expect(failed.getDataset(null)).rejects.toMatchObject({code:"QUERY_FAILED",message:"区域查询失败"});
});
it("authorizes the resolved dataset before accessing its nodes", async () => {
  const findNodes = vi.fn();
  const view = {resolveDataset:async()=>({datasetId:"resolved",versionCode:"v1",status:"ready"}),findNodes} as unknown as ReadView;
  const store: AreaStore = {read:async work=>work(view),write:vi.fn()};
  const authorize = vi.fn(async (_ctx: null, request: {datasetId?:string})=>request.datasetId===undefined);
  expect(server).toHaveProperty("createAreaKit");
  await expect(server.createAreaKit({store,authorize}).getRegion(null,{code:"01"})).rejects.toMatchObject({code:"FORBIDDEN"});
  expect(findNodes).not.toHaveBeenCalled();
  expect(authorize.mock.calls.map(call=>call[1])).toEqual([{action:"read"},{action:"read",datasetId:"resolved",versionCode:"v1",code:"01"}]);
});
it("requires admin read before listing unavailable versions", async () => {
  const read = vi.fn();
  expect(server).toHaveProperty("createAreaKit");
  const kit=server.createAreaKit({store:{read,write:vi.fn()},authorize:async(_,r)=>r.action==="read"});
  await expect(kit.listDatasets(null,{includeUnavailable:true})).rejects.toMatchObject({code:"FORBIDDEN"});
  expect(read).not.toHaveBeenCalled();
});
it("projects custom store records into public dataset summaries", async () => {
  const row = {datasetId:"d",versionCode:"v",source:"s",sourceCommit:"c",rulesVersion:"r",codeScheme:"x",
    dataAsOf:"date",sourcePublishedAt:"date",coverage:{levels:[1],excluded:[],description:""},levelCounts:{1:1},
    status:"ready",isActive:true,importedAt:null,report:{secret:"secret"},progress:{secret:"secret"},fileChecksums:[]} as unknown as DatasetRecord;
  const view={resolveDataset:async()=>row,listDatasets:async()=>({items:[row],hasMore:false,nextCursor:null})} as unknown as ReadView;
  expect(server).toHaveProperty("createAreaKit");
  const kit=server.createAreaKit({store:{read:async work=>work(view),write:vi.fn()},authorize:async()=>true});
  for(const result of [await kit.getDataset(null),(await kit.listDatasets(null)).items[0]]) {
    expect(result).not.toHaveProperty("report");expect(result).not.toHaveProperty("progress");expect(result).not.toHaveProperty("fileChecksums");
  }
});
it("rejects null pagination values instead of silently defaulting", async () => {
  const view = {resolveDataset:async()=>({datasetId:"d",versionCode:"v",status:"ready"}),listDatasets:async()=>({items:[],hasMore:false,nextCursor:null})} as unknown as ReadView;
  const kit=server.createAreaKit({store:{read:async work=>work(view),write:vi.fn()},authorize:async()=>true});
  await expect(kit.listDatasets(null,{limit:null as unknown as number})).rejects.toMatchObject({code:"INVALID_ARGUMENT"});
});
it("strictly validates cursor structure, version, filters, key types and canonical base64url", async()=>{
  const {encodeCursor,decodeCursor}=await import("../src/server/cursor.js");
  const query={level:1 as const};const cursor=encodeCursor("library","dataset",query,{sort:-1,code:"01"});
  expect(decodeCursor(cursor,"library","dataset",{selectableOnly:false,level:1})).toEqual({sort:-1,code:"01"});
  const payload=JSON.parse(Buffer.from(cursor,"base64url").toString());
  for(const changed of [{...payload,v:2},{...payload,key:{sort:0,code:1}},{...payload,key:{sort:1.5,code:"01"}},
    {...payload,key:{sort:2147483648,code:"01"}},{...payload,key:{sort:0,code:"01",extra:true}},
    {...payload,query:{level:1}},{...payload,query:{level:1,selectableOnly:false,keyword:"x"}},
    {...payload,query:null},{...payload,libraryKey:"other"},{...payload,datasetId:"other"}]){
    expect(()=>decodeCursor(Buffer.from(JSON.stringify(changed)).toString("base64url"),"library","dataset",query)).toThrowError(expect.objectContaining({code:"INVALID_ARGUMENT"}));
  }
});
