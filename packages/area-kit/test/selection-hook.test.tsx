// @vitest-environment jsdom
import {act, renderHook, waitFor} from "@testing-library/react";
import {StrictMode, type ReactNode, useState} from "react";
import {expect, it, vi} from "vitest";
import {useAreaSelection, type AreaSelectionClient} from "../src/react/use-area-selection.js";
import type {AreaValue, Level, Page, PathResult, RegionSummary, SearchHit, SelectionPolicy, SelectionResult} from "../src/types.js";
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

function useAcceptingSelection(input: ReturnType<typeof props>) {
  const [value,setValue]=useState(input.value);
  return useAreaSelection({...input,value,onChange:(next,result)=>{input.onChange(next,result);setValue(next);}});
}

function accepted(pathCodes: string[], targetLevel: Level = 3): SelectionResult {
  const endpoint=pathCodes.at(-1)!;
  return {datasetId:syntheticDataset().datasetId,versionCode:"synthetic:v1",code:endpoint,level:1 as const,actualLevel:1 as const,pathCodes,pathNames:["合成省"],
    candidatePathCodes:pathCodes,targetLevel,reachedTargetLevel:true,accepted:true,reason:"TARGET_REACHED"};
}

it("loads the active dataset after StrictMode replays effect cleanup", async () => {
  const getDataset=vi.fn(async()=>syntheticDataset());
  const client=fakeClient({getDataset,listProvinces:async()=>page([province])});
  const wrapper=({children}: {children: ReactNode})=><StrictMode>{children}</StrictMode>;
  const {result}=renderHook(()=>useAreaSelection(props(client)),{wrapper});
  await waitFor(()=>expect(result.current.state.layers[0]).toMatchObject({phase:"loaded",items:[province]}));
  expect(result.current.state.dataset).toEqual(syntheticDataset());
  expect(getDataset).toHaveBeenCalled();
});

it("restores the supplied value when a host declines an onChange path mutation", async () => {
  const input=props(fakeClient({listProvinces:async()=>page([province]),listChildren:async()=>page([city]),validateSelection:async()=>accepted(["01"])}));
  const {result}=renderHook(()=>useAreaSelection(input));
  await waitFor(()=>expect(result.current.state.layers[0]?.phase).toBe("loaded"));
  act(()=>result.current.choose(province));
  expect(input.onChange).toHaveBeenCalledWith(expect.objectContaining({code:"01"}),null);
  await waitFor(()=>expect(result.current.state.path).toEqual([]));
  expect(result.current.state.layers).toHaveLength(1);
});

it("surfaces an initial dataset failure and retries it", async () => {
  const getDataset=vi.fn().mockRejectedValueOnce(new Error("dataset offline")).mockResolvedValueOnce(syntheticDataset());
  const client=fakeClient({getDataset,listProvinces:async()=>page([province])});
  const {result}=renderHook(()=>useAreaSelection(props(client)));
  await waitFor(()=>expect(result.current.state.layers[0]).toMatchObject({phase:"error",error:"dataset offline"}));
  await act(async()=>{await result.current.retry(0);});
  await waitFor(()=>expect(result.current.state.layers[0]).toMatchObject({phase:"loaded",items:[province]}));
});

it("clears a stale controlled path after hydration fails and retries it", async () => {
  const child=syntheticRegion({code:"0101",level:2,parentCode:"01"});
  const oldPath: PathResult={datasetId:syntheticDataset().datasetId,versionCode:"synthetic:v1",nodes:[province],pathCodes:["01"],pathNames:["合成省"]};
  const newPath: PathResult={datasetId:syntheticDataset().datasetId,versionCode:"synthetic:v1",nodes:[province,child],pathCodes:["01","0101"],pathNames:["合成省","合成市"]};
  const getPath=vi.fn().mockResolvedValueOnce(oldPath).mockRejectedValueOnce(new Error("path offline")).mockResolvedValueOnce(newPath);
  const client=fakeClient({getPath,listProvinces:async()=>page([province]),listChildren:async()=>page([child]),validateSelection:async()=>accepted(["01"])});
  const initial=props(client,{datasetId:syntheticDataset().datasetId,code:"01",pathCodes:["01"]});
  const {result,rerender}=renderHook(({input})=>useAreaSelection(input),{initialProps:{input:initial}});
  await waitFor(()=>expect(result.current.state.path).toEqual([province]));
  await act(async()=>{rerender({input:props(client,{datasetId:syntheticDataset().datasetId,code:"0101",pathCodes:["01","0101"]})});});
  await waitFor(()=>expect(result.current.state.layers[0]).toMatchObject({phase:"error",error:"path offline"}));
  expect(result.current.state.path).toEqual([]);
  await act(async()=>{await result.current.retry(0);});
  await waitFor(()=>expect(result.current.state.path).toEqual([province,child]));
});

it("clears an unvalidated path after validation fails and retries it", async () => {
  const path: PathResult={datasetId:syntheticDataset().datasetId,versionCode:"synthetic:v1",nodes:[province],pathCodes:["01"],pathNames:["合成省"]};
  const validateSelection=vi.fn().mockRejectedValueOnce(new Error("validation offline")).mockResolvedValueOnce(accepted(["01"]));
  const client=fakeClient({getPath:async()=>path,listProvinces:async()=>page([province]),listChildren:async()=>page([]),validateSelection});
  const input=props(client,{datasetId:syntheticDataset().datasetId,code:"01",pathCodes:["01"]});
  const {result}=renderHook(()=>useAreaSelection(input));
  await waitFor(()=>expect(result.current.state.layers[0]).toMatchObject({phase:"error",error:"validation offline"}));
  expect(result.current.state.path).toEqual([]);
  await act(async()=>{await result.current.retry(0);});
  await waitFor(()=>expect(result.current.state.status).toEqual(accepted(["01"])));
});

it("preserves a valid controlled path and exposes retry when search-hit hydration fails", async () => {
  const path: PathResult={datasetId:syntheticDataset().datasetId,versionCode:"synthetic:v1",nodes:[province],pathCodes:["01"],pathNames:["合成省"]};
  const getPath=vi.fn().mockResolvedValueOnce(path).mockRejectedValueOnce(new Error("search path offline")).mockResolvedValueOnce(path);
  const client=fakeClient({getPath,listProvinces:async()=>page([province]),listChildren:async()=>page([]),validateSelection:async()=>accepted(["01"])});
  const input=props(client,{datasetId:syntheticDataset().datasetId,code:"01",pathCodes:["01"]});
  const {result}=renderHook(()=>useAreaSelection(input));
  await waitFor(()=>expect(result.current.state.status).toEqual(accepted(["01"])));
  input.onStatus.mockClear();
  input.onChange.mockClear();
  const hit={...province,code:"search",pathCodes:["search"],pathNames:["搜索结果"]} as SearchHit;
  await act(async()=>{await result.current.selectSearchHit(hit);});
  await waitFor(()=>expect(result.current.state.layers[0]).toMatchObject({phase:"error",error:"search path offline"}));
  expect(result.current.state.path).toEqual([province]);
  expect(result.current.state.status).toBeNull();
  expect(input.onStatus).toHaveBeenCalledWith(null);
  expect(input.onChange).not.toHaveBeenCalled();
  await act(async()=>{await result.current.retry(0);});
  await waitFor(()=>expect(result.current.state.status).toEqual(accepted(["01"])));
});

it("does not allow an old child response to restore a declined controlled selection", async () => {
  const oldChildren=deferred<Page<RegionSummary>>();
  const client=fakeClient({
    listProvinces: async()=>page([province]),
    listChildren: ()=>oldChildren.promise,
    validateSelection: async()=>unaccepted(["01"]),
  });
  const input=props(client);
  const {result}=renderHook(()=>useAreaSelection(input));
  await waitFor(()=>expect(result.current.state.layers[0]?.phase).toBe("loaded"));
  act(()=>result.current.choose(province));
  await act(async()=>{oldChildren.resolve(page([syntheticRegion({code:"old",parentCode:"01"})]));});
  await waitFor(()=>expect(result.current.state.path).toEqual([]));
  expect(result.current.state.layers).toHaveLength(1);
});

it("does not show an error when an aborted layer request rejects late", async () => {
  const oldChildren=deferred<Page<RegionSummary>>();
  let calls=0;
  const client=fakeClient({
    listProvinces: async()=>page([province,syntheticRegion({code:"02",label:"乙省",hasChildren:true})]),
    listChildren: async()=>{calls++; return oldChildren.promise;},
    validateSelection: async()=>unaccepted(["01"]),
  });
  const {result}=renderHook(()=>useAreaSelection(props(client)));
  await waitFor(()=>expect(result.current.state.layers[0]?.phase).toBe("loaded"));
  act(()=>result.current.choose(province));
  await waitFor(()=>expect(calls).toBe(1));
  await act(async()=>{oldChildren.reject(new Error("late transport failure"));});
  await waitFor(()=>expect(result.current.state.path).toEqual([]));
  expect(result.current.state.layers[0]).toMatchObject({error:null});
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

it("revalidates a hydrated controlled value after target changes and publishes the invalidation", async () => {
  const path: PathResult={datasetId:syntheticDataset().datasetId,versionCode:"synthetic:v1",nodes:[province],pathCodes:["01"],pathNames:["合成省"]};
  const nextValidation=deferred<SelectionResult>();
  const policyValidation=deferred<SelectionResult>();
  let validations=0;
  const client=fakeClient({
    getPath: async()=>path,
    listProvinces: async()=>page([province]),
    listChildren: async()=>page([]),
    validateSelection: async()=>{
      validations++;
      return validations===1 ? accepted(["01"],3) : validations===2 ? nextValidation.promise : policyValidation.promise;
    },
  });
  const onChange=vi.fn();
  const onStatus=vi.fn();
  const value={datasetId:syntheticDataset().datasetId,code:"01",pathCodes:["01"]};
  type HydrationProps = {targetLevel: Level; policy?: SelectionPolicy};
  const {result,rerender}=renderHook<ReturnType<typeof useAreaSelection>,HydrationProps>(
    ({targetLevel,policy})=>useAreaSelection({client,value,targetLevel,onChange,onStatus,...(policy===undefined ? {} : {policy})}),
    {initialProps:{targetLevel:3 as Level}},
  );
  await waitFor(()=>expect(result.current.state.status).toEqual(accepted(["01"],3)));
  onStatus.mockClear();
  await act(async()=>{rerender({targetLevel:2});});
  await waitFor(()=>expect(validations).toBe(2));
  expect(onStatus).toHaveBeenCalledWith(null);
  await act(async()=>{nextValidation.resolve(accepted(["01"],2));});
  await waitFor(()=>expect(result.current.state.status).toEqual(accepted(["01"],2)));
  expect(onStatus).toHaveBeenLastCalledWith(accepted(["01"],2));
  onStatus.mockClear();
  await act(async()=>{rerender({targetLevel:2,policy:{allowEarlyTermination:true}});});
  await waitFor(()=>expect(validations).toBe(3));
  expect(onStatus).toHaveBeenCalledWith(null);
  await act(async()=>{policyValidation.resolve(accepted(["01"],2));});
  await waitFor(()=>expect(onStatus).toHaveBeenLastCalledWith(accepted(["01"],2)));
});

it("clears hydrated state when the controlled value becomes null", async () => {
  const path: PathResult={datasetId:syntheticDataset().datasetId,versionCode:"synthetic:v1",nodes:[province],pathCodes:["01"],pathNames:["合成省"]};
  const client=fakeClient({getPath:async()=>path,listProvinces:async()=>page([province]),listChildren:async()=>page([]),validateSelection:async()=>accepted(["01"])});
  const initial=props(client,{datasetId:syntheticDataset().datasetId,code:"01",pathCodes:["01"]});
  const {result,rerender}=renderHook(({input})=>useAreaSelection(input),{initialProps:{input:initial}});
  await waitFor(()=>expect(result.current.state.path).toEqual([province]));
  await act(async()=>{rerender({input:props(client,null)});});
  await waitFor(()=>expect(result.current.state.path).toEqual([]));
  expect(result.current.state.layers).toHaveLength(1);
});

it("returns no result for superseded or cleared searches even when abort is ignored", async () => {
  const first=deferred<Page<SearchHit>>();
  const second=deferred<Page<SearchHit>>();
  const cleared=deferred<Page<SearchHit>>();
  const rejected=deferred<Page<SearchHit>>();
  let calls=0;
  const hit={...province,pathCodes:["01"],pathNames:["合成省"]} as SearchHit;
  const client=fakeClient({search:async()=>[first,second,cleared,rejected][calls++]!.promise,listProvinces:async()=>page([])});
  const {result}=renderHook(()=>useAreaSelection(props(client)));
  await waitFor(()=>expect(result.current.state.dataset).not.toBeNull());
  const old=result.current.search("old");
  const current=result.current.search("current");
  await act(async()=>{second.resolve({datasetId:syntheticDataset().datasetId,versionCode:"synthetic:v1",items:[hit],hasMore:false,nextCursor:null});});
  expect(await current).toEqual([hit]);
  await act(async()=>{first.resolve({datasetId:syntheticDataset().datasetId,versionCode:"synthetic:v1",items:[hit],hasMore:false,nextCursor:null});});
  expect(await old).toEqual([]);
  const pending=result.current.search("cleared");
  expect(await result.current.search("")).toEqual([]);
  await act(async()=>{cleared.resolve({datasetId:syntheticDataset().datasetId,versionCode:"synthetic:v1",items:[hit],hasMore:false,nextCursor:null});});
  expect(await pending).toEqual([]);
  const failing=result.current.search("failing");
  expect(await result.current.search("")).toEqual([]);
  await act(async()=>{rejected.reject(new Error("late failure"));});
  expect(await failing).toEqual([]);
});

it("does not notify status after unmount when validation completes late", async () => {
  const validation=deferred<SelectionResult>();
  const client=fakeClient({
    listProvinces:async()=>page([province]),
    listChildren:async()=>page([]),
    validateSelection:async()=>validation.promise,
  });
  const input=props(client);
  const {result,unmount}=renderHook(()=>useAreaSelection(input));
  await waitFor(()=>expect(result.current.state.layers[0]?.phase).toBe("loaded"));
  act(()=>result.current.choose(province));
  await waitFor(()=>expect(input.onChange).toHaveBeenCalledTimes(1));
  input.onStatus.mockClear();
  unmount();
  await act(async()=>{validation.resolve(accepted(["01"]));});
  expect(input.onStatus).not.toHaveBeenCalled();
});

it("does not notify after unmount when search-hit hydration completes late", async () => {
  const selectedPath=deferred<PathResult>();
  const getPath=vi.fn(async()=>selectedPath.promise);
  const client=fakeClient({listProvinces:async()=>page([province]),getPath});
  const input=props(client);
  const {result,unmount}=renderHook(()=>useAreaSelection(input));
  await waitFor(()=>expect(result.current.state.layers[0]?.phase).toBe("loaded"));
  const hit={...province,code:"search",pathCodes:["search"],pathNames:["搜索结果"]} as SearchHit;
  let selecting!: Promise<void>;
  act(()=>{selecting=result.current.selectSearchHit(hit);});
  await waitFor(()=>expect(getPath).toHaveBeenCalledWith(expect.objectContaining({code:"search"}),expect.any(AbortSignal)));
  input.onStatus.mockClear();
  unmount();
  await act(async()=>{
    selectedPath.resolve({datasetId:syntheticDataset().datasetId,versionCode:"synthetic:v1",nodes:[province],pathCodes:["01"],pathNames:["合成省"]});
    await selecting;
  });
  expect(input.onChange).not.toHaveBeenCalled();
  expect(input.onStatus).not.toHaveBeenCalled();
});

it("clears the status and emits a null value without retaining a previous acceptance", async () => {
  const accepted={...unaccepted(["01"]),accepted:true,reason:"TARGET_REACHED",code:"01",level:1,actualLevel:1,
    pathCodes:["01"],pathNames:["合成省"],reachedTargetLevel:true} as SelectionResult;
  const path: PathResult={datasetId:syntheticDataset().datasetId,versionCode:"synthetic:v1",nodes:[province],pathCodes:["01"],pathNames:["合成省"]};
  const client=fakeClient({getPath:async()=>path,listProvinces:async()=>page([province]),listChildren:async()=>page([]),validateSelection:async()=>accepted});
  const input=props(client,{datasetId:syntheticDataset().datasetId,code:"01",pathCodes:["01"]});
  const {result}=renderHook(()=>useAcceptingSelection(input));
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
  const path: PathResult={datasetId:syntheticDataset().datasetId,versionCode:"synthetic:v1",nodes:[province],pathCodes:["01"],pathNames:["合成省"]};
  const client=fakeClient({getPath:async()=>path,listProvinces:async()=>page([province]),listChildren,validateSelection:async()=>unaccepted(["01"])});
  const {result}=renderHook(()=>useAreaSelection(props(client,{datasetId:syntheticDataset().datasetId,code:"01",pathCodes:["01"]})));
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
