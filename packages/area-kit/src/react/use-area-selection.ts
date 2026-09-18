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
  const onChangeRef=useRef(props.onChange);
  onChangeRef.current=props.onChange;
  const onStatusRef=useRef(props.onStatus);
  onStatusRef.current=props.onStatus;
  const valueRef=useRef(props.value);
  valueRef.current=props.value;
  const valueKeyRef=useRef(externalValueKey);
  valueKeyRef.current=externalValueKey;
  const generationRef=useRef(0);
  const requestRef=useRef(0);
  const searchRequestRef=useRef(0);
  const previousRef=useRef({disabled,targetLevel,policyKey,valueKey:externalValueKey});
  const layerControllers=useRef(new Map<number,AbortController>());
  const searchController=useRef<AbortController | null>(null);
  const datasetController=useRef<AbortController | null>(null);
  const pathController=useRef<AbortController | null>(null);
  const validationController=useRef<AbortController | null>(null);

  const invalidateSearch=useCallback(() => {
    searchRequestRef.current++;
    searchController.current?.abort();
    searchController.current=null;
  },[]);

  const abortAll=useCallback(() => {
    for (const controller of layerControllers.current.values()) controller.abort();
    layerControllers.current.clear();
    invalidateSearch();
    datasetController.current?.abort();
    pathController.current?.abort();
    validationController.current?.abort();
    datasetController.current=null;
    pathController.current=null;
    validationController.current=null;
  },[invalidateSearch]);

  const currentGeneration=useCallback(() => generationRef.current,[]);

  const failRoot=useCallback((generation: number, error: unknown, path: readonly RegionSummary[] = []) => {
    if (generation!==currentGeneration()) return;
    const requestId=++requestRef.current;
    dispatch({type:"hydrate",generation,path:[...path]});
    dispatch({type:"start",generation,layerIndex:0,requestId});
    dispatch({type:"failed",generation,layerIndex:0,requestId,message:message(error)});
    onStatusRef.current?.(null);
  },[currentGeneration]);

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
      onStatusRef.current?.(result);
    } catch (error) {
      if (generation!==currentGeneration() || isAbort(error)) return;
      failRoot(generation,error);
    } finally {
      if (validationController.current===controller) validationController.current=null;
    }
  },[currentGeneration,failRoot,props.client,targetLevel]);

  const hydrateValue=useCallback(async (generation: number, dataset: DatasetSummary, value: AreaValue): Promise<void> => {
    pathController.current?.abort();
    const controller=new AbortController();
    pathController.current=controller;
    const requestId=++requestRef.current;
    dispatch({type:"start",generation,layerIndex:0,requestId});
    try {
      const result=await props.client.getPath({datasetId:dataset.datasetId,code:value.code},controller.signal);
      if (generation!==currentGeneration()) return;
      dispatch({type:"hydrate",generation,path:result.nodes});
      void validate(generation,dataset,result.nodes);
      for (let index=0; index<=result.nodes.length; index++) {
        const parentCode=index===0 ? null : result.nodes[index-1]?.code ?? null;
        void loadLayer(generation,index,parentCode,dataset,null);
      }
    } catch (error) {
      if (generation!==currentGeneration() || isAbort(error)) return;
      failRoot(generation,error);
    } finally {
      if (pathController.current===controller) pathController.current=null;
    }
  },[currentGeneration,failRoot,loadLayer,props.client,validate]);

  const bootstrap=useCallback(async (generation: number): Promise<void> => {
    if (generation!==currentGeneration()) return;
    datasetController.current?.abort();
    const controller=new AbortController();
    datasetController.current=controller;
    const requestId=++requestRef.current;
    dispatch({type:"start",generation,layerIndex:0,requestId});
    const value=valueRef.current;
    try {
      const dataset=await props.client.getDataset(value===null ? {} : {datasetId:value.datasetId},controller.signal);
      if (generation!==currentGeneration()) return;
      dispatch({type:"dataset",generation,dataset});
      if (value===null) void loadLayer(generation,0,null,dataset,null);
      else void hydrateValue(generation,dataset,value);
    } catch (error) {
      if (generation!==currentGeneration() || isAbort(error)) return;
      failRoot(generation,error);
    } finally {
      if (datasetController.current===controller) datasetController.current=null;
    }
  },[currentGeneration,failRoot,hydrateValue,loadLayer,props.client]);

  useEffect(() => {
    const previous=previousRef.current;
    const changed=previous.disabled!==disabled || previous.targetLevel!==targetLevel || previous.policyKey!==policyKey || previous.valueKey!==externalValueKey;
    if (changed) {
      generationRef.current++;
      abortAll();
      dispatch({type:"props",disabled,targetLevel,policyKey,valueKey:externalValueKey});
      onStatusRef.current?.(null);
      previousRef.current={disabled,targetLevel,policyKey,valueKey:externalValueKey};
    }
    const generation=currentGeneration();
    if (disabled) return;
    void bootstrap(generation);
  },[abortAll,bootstrap,currentGeneration,disabled,externalValueKey,policyKey,targetLevel]);

  useEffect(() => () => {
    const generation=++generationRef.current;
    abortAll();
    dispatch({type:"lifecycle",generation});
  },[abortAll]);

  const reconcileControlledValue=useCallback((generation: number, expectedValueKey: string) => {
    queueMicrotask(() => {
      if (generation!==currentGeneration() || valueKeyRef.current!==expectedValueKey) return;
      const snapshot=stateRef.current;
      const nextGeneration=++generationRef.current;
      abortAll();
      dispatch({type:"lifecycle",generation:nextGeneration});
      onStatusRef.current?.(null);
      const value=valueRef.current;
      if (snapshot.dataset===null) {
        void bootstrap(nextGeneration);
      } else if (value===null) {
        dispatch({type:"hydrate",generation:nextGeneration,path:[]});
        void loadLayer(nextGeneration,0,null,snapshot.dataset,null);
      } else {
        void hydrateValue(nextGeneration,snapshot.dataset,value);
      }
    });
  },[abortAll,bootstrap,currentGeneration,hydrateValue,loadLayer]);

  const choose=useCallback((node: RegionSummary) => {
    const snapshot=stateRef.current;
    if (snapshot.disabled || !snapshot.dataset) return;
    const generation=++generationRef.current;
    abortAll();
    const path=pathWith(snapshot.path,node);
    const expectedValueKey=valueKeyRef.current;
    dispatch({type:"choose",node});
    onChangeRef.current(asValue(snapshot.dataset,path),null);
    onStatusRef.current?.(null);
    reconcileControlledValue(generation,expectedValueKey);
    void validate(generation,snapshot.dataset,path);
    void loadLayer(generation,node.level,node.code,snapshot.dataset,null);
  },[abortAll,loadLayer,reconcileControlledValue,validate]);

  const clear=useCallback(() => {
    if (stateRef.current.disabled) return;
    generationRef.current++;
    abortAll();
    const expectedValueKey=valueKeyRef.current;
    dispatch({type:"clear"});
    onChangeRef.current(null,null);
    onStatusRef.current?.(null);
    reconcileControlledValue(generationRef.current,expectedValueKey);
  },[abortAll,reconcileControlledValue]);

  const loadMore=useCallback(async (layerIndex: number): Promise<void> => {
    const snapshot=stateRef.current;
    const current: LayerState | undefined=snapshot.layers[layerIndex];
    if (snapshot.disabled || !snapshot.dataset || !current || current.phase==="loading" || !current.hasMore || current.nextCursor===null) return;
    await loadLayer(currentGeneration(),layerIndex,current.parentCode,snapshot.dataset,current.nextCursor);
  },[currentGeneration,loadLayer]);

  const retry=useCallback(async (layerIndex: number): Promise<void> => {
    const snapshot=stateRef.current;
    const current: LayerState | undefined=snapshot.layers[layerIndex];
    if (snapshot.disabled || !current || current.phase!=="error") return;
    if (snapshot.dataset===null) {
      await bootstrap(currentGeneration());
      return;
    }
    if (layerIndex===0 && valueRef.current!==null) {
      await hydrateValue(currentGeneration(),snapshot.dataset,valueRef.current);
      return;
    }
    await loadLayer(currentGeneration(),layerIndex,current.parentCode,snapshot.dataset,current.nextCursor);
  },[bootstrap,currentGeneration,hydrateValue,loadLayer]);

  const search=useCallback(async (keyword: string): Promise<SearchHit[]> => {
    const snapshot=stateRef.current;
    if (snapshot.disabled || !snapshot.dataset || keyword.length===0) {
      invalidateSearch();
      return [];
    }
    invalidateSearch();
    const controller=new AbortController();
    searchController.current=controller;
    const generation=currentGeneration();
    const requestId=searchRequestRef.current;
    try {
      const page=await props.client.search({datasetId:snapshot.dataset.datasetId,keyword},controller.signal);
      return generation===currentGeneration() && requestId===searchRequestRef.current ? page.items : [];
    } catch (error) {
      if (isAbort(error) || generation!==currentGeneration() || requestId!==searchRequestRef.current) return [];
      throw error;
    } finally {
      if (searchController.current===controller) searchController.current=null;
    }
  },[currentGeneration,invalidateSearch,props.client]);

  const selectSearchHit=useCallback(async (hit: SearchHit): Promise<void> => {
    const snapshot=stateRef.current;
    if (snapshot.disabled || !snapshot.dataset) return;
    const generation=++generationRef.current;
    abortAll();
    dispatch({type:"clear"});
    onStatusRef.current?.(null);
    pathController.current=new AbortController();
    const controller=pathController.current;
    try {
      const result=await props.client.getPath({datasetId:snapshot.dataset.datasetId,code:hit.code},controller.signal);
      if (generation!==currentGeneration()) return;
      const path=result.nodes;
      const expectedValueKey=valueKeyRef.current;
      dispatch({type:"hydrate",generation,path});
      onChangeRef.current(asValue(snapshot.dataset,path),null);
      onStatusRef.current?.(null);
      reconcileControlledValue(generation,expectedValueKey);
      void validate(generation,snapshot.dataset,path);
      for (let index=0; index<=path.length; index++) {
        const parentCode=index===0 ? null : path[index-1]?.code ?? null;
        void loadLayer(generation,index,parentCode,snapshot.dataset,null);
      }
    } catch (error) {
      if (generation!==currentGeneration() || isAbort(error)) return;
      failRoot(generation,error,snapshot.path);
    } finally {
      if (pathController.current===controller) pathController.current=null;
    }
  },[abortAll,loadLayer,props.client,reconcileControlledValue,validate]);

  return {state,choose,loadMore,retry,search,selectSearchHit,clear};
}
