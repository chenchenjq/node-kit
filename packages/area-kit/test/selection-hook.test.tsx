// @vitest-environment jsdom
import {act, renderHook, waitFor} from "@testing-library/react";
import {expect, it, vi} from "vitest";
import {useAreaSelection, type AreaSelectionClient} from "../src/react/use-area-selection.js";
import type {AreaValue, Page, PathResult, RegionSummary, SearchHit, SelectionResult} from "../src/types.js";
import {syntheticDataset, syntheticRegion} from "./fixtures/factory.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise=new Promise<T>((res,rej)=>{resolve=res;reject=rej;});
  return {promise,resolve,reject};
}

function page(items: RegionSummary[], nextCursor: string | null = null): Page<RegionSummary> {
  return {datasetId:syntheticDataset().datasetId,versionCode:"synthetic:v1",items,hasMore:nextCursor!==null,nextCursor};
}

function fakeClient(overrides: Partial<AreaSelectionClient> = {}): AreaSelectionClient {
  const unexpected=(name:string)=>()=>{throw new Error(`unexpected ${name} call`);};
  return {
    getDataset: async()=>syntheticDataset(),
    listProvinces: async()=>page([]),
    listChildren: unexpected("listChildren") as AreaSelectionClient["listChildren"],
    getPath: unexpected("getPath") as AreaSelectionClient["getPath"],
    search: unexpected("search") as AreaSelectionClient["search"],
    validateSelection: unexpected("validateSelection") as AreaSelectionClient["validateSelection"],
    ...overrides,
  };
}

const province=syntheticRegion({code:"01",level:1,hasChildren:true});
const city=syntheticRegion({code:"0101",level:2,parentCode:"01",hasChildren:true});

function props(client: AreaSelectionClient, value: AreaValue | null = null) {
  return {client,value,onChange:vi.fn(),onStatus:vi.fn()};
}

it("does not allow an old child response to overwrite a newer parent layer", async () => {
  const oldChildren=deferred<Page<RegionSummary>>();
  const newChildren=deferred<Page<RegionSummary>>();
  let calls=0;
  const client=fakeClient({
    listProvinces: async()=>page([province,syntheticRegion({code:"02",label:"乙省",hasChildren:true})]),
    listChildren: ()=>++calls===1 ? oldChildren.promise : newChildren.promise,
    validateSelection: async()=>unaccepted(["01"]),
  });
  const input=props(client);
  const {result}=renderHook(()=>useAreaSelection(input));
  await waitFor(()=>expect(result.current.state.layers[0]?.phase).toBe("loaded"));
  await act(async()=>{result.current.choose(province);});
  await waitFor(()=>expect(calls).toBe(1));
  const other=syntheticRegion({code:"02",label:"乙省",level:1,hasChildren:true});
  await act(async()=>{result.current.choose(other);});
  await waitFor(()=>expect(calls).toBe(2));
  await act(async()=>{newChildren.resolve(page([city]));});
  await waitFor(()=>expect(result.current.state.layers[1]?.items).toEqual([city]));
  await act(async()=>{oldChildren.resolve(page([syntheticRegion({code:"old",parentCode:"01"})]));});
  await Promise.resolve();
  expect(result.current.state.layers[1]?.parentCode).toBe("02");
  expect(result.current.state.layers[1]?.items).toEqual([city]);
});

it("does not show an error when an aborted layer request rejects late", async () => {
  const oldChildren=deferred<Page<RegionSummary>>();
  const client=fakeClient({
    listProvinces: async()=>page([province,syntheticRegion({code:"02",label:"乙省",hasChildren:true})]),
    listChildren: async()=>oldChildren.promise,
    validateSelection: async()=>unaccepted(["01"]),
  });
  const {result}=renderHook(()=>useAreaSelection(props(client)));
  await waitFor(()=>expect(result.current.state.layers[0]?.phase).toBe("loaded"));
  await act(async()=>{result.current.choose(province);});
  await waitFor(()=>expect(result.current.state.layers[1]?.phase).toBe("loading"));
  act(()=>result.current.clear());
  await act(async()=>{oldChildren.reject(new Error("late transport failure"));});
  expect(result.current.state.layers[0]).toMatchObject({phase:"unloaded",error:null});
  expect(result.current.state.layers).toHaveLength(1);
});

it("does not hydrate a stale search path after the controlled value changes", async () => {
  const searchPath=deferred<PathResult>();
  const previousPath: PathResult={datasetId:syntheticDataset().datasetId,versionCode:"synthetic:v1",nodes:[province],pathCodes:["01"],pathNames:["合成省"]};
  const client=fakeClient({
    getPath: vi.fn(async(input:{code:string})=>input.code==="search" ? searchPath.promise : previousPath),
    listProvinces: async()=>page([province]),
    listChildren: async()=>page([]),
    validateSelection: async()=>unaccepted(["01"]),
  });
  const initial=props(client,{datasetId:syntheticDataset().datasetId,code:"01",pathCodes:["01"]});
  const {result,rerender}=renderHook(({input})=>useAreaSelection(input),{initialProps:{input:initial}});
  await waitFor(()=>expect(result.current.state.path).toEqual([province]));
  const hit={...province,code:"search",pathCodes:["search"],pathNames:["搜索结果"]} as SearchHit;
  let selecting!: Promise<void>;
  act(()=>{selecting=result.current.selectSearchHit(hit);});
  await waitFor(()=>expect(client.getPath).toHaveBeenCalledWith(expect.objectContaining({code:"search"}),expect.any(AbortSignal)));
  const replacement=props(client,{datasetId:syntheticDataset().datasetId,code:"01",pathCodes:["01","0101"]});
  await act(async()=>{rerender({input:replacement});});
  await act(async()=>{
    searchPath.resolve({...previousPath,nodes:[{...province,code:"search"}],pathCodes:["search"],pathNames:["搜索结果"]});
    await selecting;
  });
  await waitFor(()=>expect(result.current.state.generation).toBeGreaterThan(1));
  expect(result.current.state.path.map(node=>node.code)).not.toContain("search");
});

it("clears the status and emits a null value without retaining a previous acceptance", async () => {
  const accepted={...unaccepted(["01"]),accepted:true,reason:"TARGET_REACHED",code:"01",level:1,actualLevel:1,
    pathCodes:["01"],pathNames:["合成省"],reachedTargetLevel:true} as SelectionResult;
  const client=fakeClient({listProvinces:async()=>page([province]),listChildren:async()=>page([]),validateSelection:async()=>accepted});
  const input=props(client);
  const {result}=renderHook(()=>useAreaSelection(input));
  await waitFor(()=>expect(result.current.state.layers[0]?.phase).toBe("loaded"));
  await act(async()=>{result.current.choose(province);});
  await waitFor(()=>expect(result.current.state.status).toEqual(accepted));
  act(()=>result.current.clear());
  expect(result.current.state.status).toBeNull();
  expect(input.onChange).toHaveBeenLastCalledWith(null,null);
});

it("retries a genuine failed layer request and keeps pagination pinned to the dataset", async () => {
  const error=new Error("offline");
  const child=syntheticRegion({code:"0101",level:2,parentCode:"01"});
  const listChildren=vi.fn()
    .mockRejectedValueOnce(error)
    .mockResolvedValueOnce(page([child],"cursor-2"))
    .mockResolvedValueOnce(page([child,syntheticRegion({code:"0102",level:2,parentCode:"01"})]));
  const client=fakeClient({listProvinces:async()=>page([province]),listChildren,validateSelection:async()=>unaccepted(["01"])});
  const {result}=renderHook(()=>useAreaSelection(props(client)));
  await waitFor(()=>expect(result.current.state.layers[0]?.phase).toBe("loaded"));
  await act(async()=>{result.current.choose(province);});
  await waitFor(()=>expect(result.current.state.layers[1]?.phase).toBe("error"));
  await act(async()=>{await result.current.retry(1);});
  await waitFor(()=>expect(result.current.state.layers[1]?.phase).toBe("loaded"));
  await act(async()=>{await result.current.loadMore(1);});
  expect(listChildren).toHaveBeenLastCalledWith(expect.objectContaining({datasetId:syntheticDataset().datasetId,cursor:"cursor-2"}),expect.any(AbortSignal));
  expect(result.current.state.layers[1]?.items.map(node=>node.code)).toEqual(["0101","0102"]);
});

function unaccepted(pathCodes: string[]): SelectionResult {
  return {datasetId:syntheticDataset().datasetId,versionCode:"synthetic:v1",code:null,level:null,actualLevel:null,pathCodes:null,pathNames:null,
    candidatePathCodes:pathCodes,targetLevel:3,reachedTargetLevel:false,accepted:false,reason:"TARGET_LEVEL_NOT_REACHED"};
}
