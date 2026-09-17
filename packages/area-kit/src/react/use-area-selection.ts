import {useCallback, useEffect, useMemo, useReducer, useRef} from "react";
import type {AreaClient} from "../client/contracts.js";
import type {AreaValue, DatasetSummary, Level, Page, RegionSummary, SearchHit, SelectionPolicy, SelectionResult} from "../types.js";
import {initialSelectionState, selectionReducer, type LayerState, type SelectionState} from "./selection-state.js";

export type AreaSelectionClient = Pick<AreaClient,"getDataset"|"listProvinces"|"listChildren"|"getPath"|"search"|"validateSelection">;

export interface AreaCascaderProps {
  client: AreaSelectionClient;
  value: AreaValue | null;
  targetLevel?: Level;
  policy?: SelectionPolicy;
  disabled?: boolean;
  className?: string;
  onChange(value: AreaValue | null, result: SelectionResult | null): void;
  onStatus?(result: SelectionResult | null): void;
}

export interface AreaSelectionController {
  state: SelectionState;
  choose(node: RegionSummary): void;
  loadMore(layerIndex: number): Promise<void>;
  retry(layerIndex: number): Promise<void>;
  search(keyword: string): Promise<SearchHit[]>;
  selectSearchHit(hit: SearchHit): Promise<void>;
  clear(): void;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value==="object") {
    const object=value as Record<string,unknown>;
    return `{${Object.keys(object).sort().map(key=>`${JSON.stringify(key)}:${stable(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function valueKey(value: AreaValue | null): string {
  return value===null ? "" : stable([value.datasetId,value.code,value.pathCodes ?? null]);
}

function message(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "区域查询失败";
}

function isAbort(error: unknown): boolean {
  return typeof error==="object" && error!==null && "name" in error && error.name==="AbortError";
}

function asValue(dataset: DatasetSummary, path: readonly RegionSummary[]): AreaValue {
  const endpoint=path.at(-1)!;
  return {datasetId:dataset.datasetId,code:endpoint.code,pathCodes:path.map(node=>node.code),pathNames:path.map(node=>node.label)};
}

function pathWith(path: readonly RegionSummary[], node: RegionSummary): RegionSummary[] {
  return [...path.filter(item=>item.level<node.level),node];
}

export function useAreaSelection(props: AreaCascaderProps): AreaSelectionController {
  const targetLevel=props.targetLevel ?? 3;
  const disabled=props.disabled ?? false;
  const policyKey=useMemo(()=>stable(props.policy ?? {}),[props.policy]);
  const externalValueKey=useMemo(()=>valueKey(props.value),[props.value]);
  const [state,dispatch]=useReducer(selectionReducer,{disabled,targetLevel,policyKey,valueKey:externalValueKey},initialSelectionState);
  const stateRef=useRef(state);
  stateRef.current=state;
  const generationRef=useRef(0);
  const requestRef=useRef(0);
  const previousRef=useRef({disabled,targetLevel,policyKey,valueKey:externalValueKey});
  const layerControllers=useRef(new Map<number,AbortController>());
  const searchController=useRef<AbortController | null>(null);
  const pathController=useRef<AbortController | null>(null);
  const validationController=useRef<AbortController | null>(null);

  const abortAll=useCallback(() => {
    for (const controller of layerControllers.current.values()) controller.abort();
    layerControllers.current.clear();
    searchController.current?.abort();
    pathController.current?.abort();
    validationController.current?.abort();
    searchController.current=null;
    pathController.current=null;
    validationController.current=null;
  },[]);

  const currentGeneration=useCallback(() => generationRef.current,[]);

  const loadLayer=useCallback(async (generation: number, layerIndex: number, parentCode: string | null, dataset: DatasetSummary,
    cursor: string | null): Promise<void> => {
    if (generation!==currentGeneration()) return;
    layerControllers.current.get(layerIndex)?.abort();
    const controller=new AbortController();
    layerControllers.current.set(layerIndex,controller);
    const requestId=++requestRef.current;
    dispatch({type:"start",generation,layerIndex,requestId});
    try {
      const page: Page<RegionSummary>=parentCode===null
        ? await props.client.listProvinces({datasetId:dataset.datasetId,...(cursor===null ? {} : {cursor})},controller.signal)
        : await props.client.listChildren({datasetId:dataset.datasetId,parentCode,...(cursor===null ? {} : {cursor})},controller.signal);
      if (generation!==currentGeneration()) return;
      dispatch({type:"loaded",generation,layerIndex,requestId,parentCode,page});
    } catch (error) {
      if (generation!==currentGeneration() || isAbort(error)) return;
      dispatch({type:"failed",generation,layerIndex,requestId,message:message(error)});
    } finally {
      if (layerControllers.current.get(layerIndex)===controller) layerControllers.current.delete(layerIndex);
    }
  },[currentGeneration,props.client]);

  const validate=useCallback(async (generation: number, dataset: DatasetSummary, path: readonly RegionSummary[]): Promise<void> => {
    validationController.current?.abort();
    const controller=new AbortController();
    validationController.current=controller;
    try {
      const result=await props.client.validateSelection({datasetId:dataset.datasetId,pathCodes:path.map(node=>node.code),targetLevel},controller.signal);
      if (generation!==currentGeneration()) return;
      dispatch({type:"status",generation,result});
      props.onStatus?.(result);
    } catch (error) {
      if (generation!==currentGeneration() || isAbort(error)) return;
      dispatch({type:"status",generation,result:null});
      props.onStatus?.(null);
    } finally {
      if (validationController.current===controller) validationController.current=null;
    }
  },[currentGeneration,props.client,props.onStatus,targetLevel]);

  const hydrateValue=useCallback(async (generation: number, dataset: DatasetSummary, value: AreaValue): Promise<void> => {
    pathController.current?.abort();
    const controller=new AbortController();
    pathController.current=controller;
    try {
      const result=await props.client.getPath({datasetId:dataset.datasetId,code:value.code},controller.signal);
      if (generation!==currentGeneration()) return;
      dispatch({type:"hydrate",generation,path:result.nodes});
      for (let index=0; index<=result.nodes.length; index++) {
        const parentCode=index===0 ? null : result.nodes[index-1]?.code ?? null;
        void loadLayer(generation,index,parentCode,dataset,null);
      }
    } catch (error) {
      if (generation!==currentGeneration() || isAbort(error)) return;
    } finally {
      if (pathController.current===controller) pathController.current=null;
    }
  },[currentGeneration,loadLayer,props.client]);

  useEffect(() => {
    const previous=previousRef.current;
    const changed=previous.disabled!==disabled || previous.targetLevel!==targetLevel || previous.policyKey!==policyKey || previous.valueKey!==externalValueKey;
    if (changed) {
      generationRef.current++;
      abortAll();
      dispatch({type:"props",disabled,targetLevel,policyKey,valueKey:externalValueKey});
      previousRef.current={disabled,targetLevel,policyKey,valueKey:externalValueKey};
    }
    const generation=currentGeneration();
    if (disabled) return;
    let disposed=false;
    const activate=async () => {
      try {
        const dataset=await props.client.getDataset(props.value===null ? {} : {datasetId:props.value.datasetId});
        if (disposed || generation!==currentGeneration()) return;
        dispatch({type:"dataset",generation,dataset});
        if (props.value===null) void loadLayer(generation,0,null,dataset,null);
        else void hydrateValue(generation,dataset,props.value);
      } catch (error) {
        if (disposed || generation!==currentGeneration() || isAbort(error)) return;
      }
    };
    void activate();
    return () => { disposed=true; };
  },[abortAll,currentGeneration,disabled,externalValueKey,hydrateValue,loadLayer,policyKey,props.client,props.value,targetLevel]);

  useEffect(() => abortAll,[abortAll]);

  const choose=useCallback((node: RegionSummary) => {
    const snapshot=stateRef.current;
    if (snapshot.disabled || !snapshot.dataset) return;
    const generation=++generationRef.current;
    abortAll();
    const path=pathWith(snapshot.path,node);
    dispatch({type:"choose",node});
    props.onChange(asValue(snapshot.dataset,path),null);
    props.onStatus?.(null);
    void validate(generation,snapshot.dataset,path);
    void loadLayer(generation,node.level,node.code,snapshot.dataset,null);
  },[abortAll,loadLayer,props.onChange,props.onStatus,validate]);

  const clear=useCallback(() => {
    if (stateRef.current.disabled) return;
    generationRef.current++;
    abortAll();
    dispatch({type:"clear"});
    props.onChange(null,null);
    props.onStatus?.(null);
  },[abortAll,props.onChange,props.onStatus]);

  const loadMore=useCallback(async (layerIndex: number): Promise<void> => {
    const snapshot=stateRef.current;
    const current: LayerState | undefined=snapshot.layers[layerIndex];
    if (snapshot.disabled || !snapshot.dataset || !current || current.phase==="loading" || !current.hasMore || current.nextCursor===null) return;
    await loadLayer(currentGeneration(),layerIndex,current.parentCode,snapshot.dataset,current.nextCursor);
  },[currentGeneration,loadLayer]);

  const retry=useCallback(async (layerIndex: number): Promise<void> => {
    const snapshot=stateRef.current;
    const current: LayerState | undefined=snapshot.layers[layerIndex];
    if (snapshot.disabled || !snapshot.dataset || !current || current.phase!=="error") return;
    await loadLayer(currentGeneration(),layerIndex,current.parentCode,snapshot.dataset,current.nextCursor);
  },[currentGeneration,loadLayer]);

  const search=useCallback(async (keyword: string): Promise<SearchHit[]> => {
    const snapshot=stateRef.current;
    if (snapshot.disabled || !snapshot.dataset || keyword.length===0) return [];
    searchController.current?.abort();
    const controller=new AbortController();
    searchController.current=controller;
    const generation=currentGeneration();
    try {
      const page=await props.client.search({datasetId:snapshot.dataset.datasetId,keyword},controller.signal);
      return generation===currentGeneration() ? page.items : [];
    } catch (error) {
      if (isAbort(error) || generation!==currentGeneration()) return [];
      throw error;
    } finally {
      if (searchController.current===controller) searchController.current=null;
    }
  },[currentGeneration,props.client]);

  const selectSearchHit=useCallback(async (hit: SearchHit): Promise<void> => {
    const snapshot=stateRef.current;
    if (snapshot.disabled || !snapshot.dataset) return;
    const generation=++generationRef.current;
    abortAll();
    dispatch({type:"clear"});
    pathController.current=new AbortController();
    const controller=pathController.current;
    try {
      const result=await props.client.getPath({datasetId:snapshot.dataset.datasetId,code:hit.code},controller.signal);
      if (generation!==currentGeneration()) return;
      const path=result.nodes;
      dispatch({type:"hydrate",generation,path});
      props.onChange(asValue(snapshot.dataset,path),null);
      props.onStatus?.(null);
      void validate(generation,snapshot.dataset,path);
      for (let index=0; index<=path.length; index++) {
        const parentCode=index===0 ? null : path[index-1]?.code ?? null;
        void loadLayer(generation,index,parentCode,snapshot.dataset,null);
      }
    } catch (error) {
      if (generation!==currentGeneration() || isAbort(error)) return;
    } finally {
      if (pathController.current===controller) pathController.current=null;
    }
  },[abortAll,loadLayer,props.client,props.onChange,props.onStatus,validate]);

  return {state,choose,loadMore,retry,search,selectSearchHit,clear};
}
