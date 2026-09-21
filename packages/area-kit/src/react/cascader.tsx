"use client";

import {useEffect, useId, useRef, useState} from "react";
import type {KeyboardEvent, ReactNode} from "react";
import type {SearchHit, SelectionResult} from "../types.js";
import {useAreaSelection, type AreaCascaderProps} from "./use-area-selection.js";

export type {AreaCascaderProps, AreaSelectionClient} from "./use-area-selection.js";

function statusMessage(result: SelectionResult | null): string | null {
  if (result===null) return null;
  switch (result.reason) {
    case "TARGET_REACHED": return `已达到目标层级 ${result.targetLevel}`;
    case "GROUP_ENDPOINT_EXCEPTION": return "统计导航分组已按当前数据集例外规则接受";
    case "EARLY_TERMINATION_ACCEPTED": return `源快照中该节点无下级；当前层级 ${result.actualLevel}，目标层级 ${result.targetLevel}，已按规则接受`;
    case "NAVIGATION_ONLY": return "统计导航分组不能作为当前选择终点";
    case "TARGET_LEVEL_NOT_REACHED": return result.actualLevel===null
      ? `当前选择尚未达到目标层级 ${result.targetLevel}`
      : `当前层级 ${result.actualLevel}，尚未达到目标层级 ${result.targetLevel}`;
    case "TARGET_LEVEL_EXCEEDED": return result.actualLevel===null
      ? `当前选择超过目标层级 ${result.targetLevel}`
      : `当前层级 ${result.actualLevel}，超过目标层级 ${result.targetLevel}`;
    case "NOT_SELECTABLE": return "当前路径包含停用区域，只读回显，不能作为当前选择终点";
    case "PARENT_MISMATCH": return "区域路径已变化，请重新选择";
    case "UNKNOWN_CODE": return "当前区域不存在于此数据集";
    case "VERSION_UNAVAILABLE": return "当前区域版本不可用";
    case "DATASET_NOT_ACCEPTED": return "当前数据集不接受该选择";
    case "NOT_INITIALIZED": return "区域数据尚未初始化";
  }
}

function searchLabel(hit: SearchHit): string {
  return `${hit.pathNames.join(" / ")}（${hit.code}）`;
}

interface BoundSearchHit {
  hit: SearchHit;
  context: string;
  datasetId: string;
  versionCode: string;
}

function LayerFeedback({children}: {children: ReactNode}) {
  return <p role="status" aria-live="polite">{children}</p>;
}

/**
 * A native-select, lazily loaded area cascader. The host owns its value and
 * submission policy; this component only presents the selection state.
 */
export function AreaCascader(props: AreaCascaderProps): React.JSX.Element {
  const controller=useAreaSelection(props);
  const {state}=controller;
  const id=useId();
  const searchId=`${id}-search`;
  const [keyword,setKeyword]=useState("");
  const [hits,setHits]=useState<BoundSearchHit[]>([]);
  const [searchError,setSearchError]=useState<string | null>(null);
  const [searching,setSearching]=useState(false);
  const searchRequest=useRef(0);
  const maxLevel=state.targetLevel;
  const valueContext=props.value===null ? "" : JSON.stringify([props.value.datasetId,props.value.code,props.value.pathCodes ?? null]);
  const searchContext=`${valueContext}|${state.dataset?.datasetId ?? ""}|${state.dataset?.versionCode ?? ""}|${state.targetLevel}|${state.policyKey}|${state.disabled}`;
  const activeSearchContext=useRef(searchContext);
  activeSearchContext.current=searchContext;
  const clearedSearchContext=useRef(searchContext);

  useEffect(()=>{
    if (clearedSearchContext.current===searchContext) return;
    clearedSearchContext.current=searchContext;
    searchRequest.current++;
    setHits([]);
    setSearchError(null);
    setSearching(false);
  },[searchContext]);

  function closeSearch(): void {
    searchRequest.current++;
    setHits([]);
    setSearchError(null);
    setSearching(false);
  }

  async function runSearch(): Promise<void> {
    const query=keyword.trim();
    const request=++searchRequest.current;
    const originDataset=state.dataset;
    const originContext=searchContext;
    setSearchError(null);
    if (!query) {
      setHits([]);
      setSearching(false);
      await controller.search("");
      return;
    }
    setSearching(true);
    try {
      const results=await controller.search(query);
      if (request===searchRequest.current && originContext===activeSearchContext.current && originDataset!==null) {
        setHits(results.map(hit=>({hit,context:originContext,datasetId:originDataset.datasetId,versionCode:originDataset.versionCode})));
      }
    } catch (error) {
      if (request===searchRequest.current) {
        setHits([]);
        setSearchError(error instanceof Error && error.message ? error.message : "区域搜索失败");
      }
    } finally {
      if (request===searchRequest.current) setSearching(false);
    }
  }

  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key==="Escape") {
      event.preventDefault();
      closeSearch();
    } else if (event.key==="Enter") {
      event.preventDefault();
      void runSearch();
    }
  }

  const loadingLevels=state.layers
    .map((layer,index)=>layer.phase==="loading" ? index+1 : null)
    .filter((level): level is number=>level!==null);
  const currentStatus=statusMessage(state.status);

  return <section className={props.className} aria-busy={loadingLevels.length>0} onKeyDown={event=>{
    if (event.key==="Escape") {
      event.preventDefault();
      closeSearch();
    }
  }}>
    <div>
      <label htmlFor={searchId}>搜索区域</label>
      <input id={searchId} value={keyword} disabled={state.disabled} onChange={event=>setKeyword(event.target.value)}
        onKeyDown={onSearchKeyDown} autoComplete="off" />
      <button type="button" disabled={state.disabled || searching} onClick={()=>void runSearch()}>{searching ? "正在搜索" : "搜索"}</button>
    </div>

    {searchError!==null ? <LayerFeedback>{searchError}</LayerFeedback> : null}
    {hits.length>0 ? <ul aria-label="区域搜索结果" onKeyDown={event=>{
      if (event.key==="Escape") { event.preventDefault(); closeSearch(); }
    }}>
      {hits.map(result=><li key={`${result.datasetId}:${result.versionCode}:${result.hit.code}`}>
        <button type="button" disabled={state.disabled} onClick={()=>{
          if (result.context!==activeSearchContext.current || state.dataset?.datasetId!==result.datasetId
            || state.dataset.versionCode!==result.versionCode) {
            closeSearch();
            setSearchError("搜索结果已过期，请重新搜索");
            return;
          }
          closeSearch();
          void controller.selectSearchHit(result.hit);
        }}>{searchLabel(result.hit)}</button>
      </li>)}
    </ul> : null}

    {state.layers.slice(0,maxLevel).map((layer,index)=>{
      const level=index+1;
      const selected=state.path.find(node=>node.level===level);
      const selectedCode=selected?.code ?? "";
      const selectedInLayer=selected!==undefined && layer.items.some(item=>item.code===selected.code);
      const options=selected!==undefined && !selectedInLayer ? [selected,...layer.items] : layer.items;
      const readOnly=selected!==undefined && !selected.navigable;
      const selectId=`${id}-level-${level}`;
      const disabled=state.disabled || readOnly || layer.phase==="loading";
      return <div key={`${level}:${layer.parentCode ?? "root"}`}>
        <label htmlFor={selectId}>第{level}级区域</label>
        <select id={selectId} disabled={disabled} value={selectedCode} onChange={event=>{
          const item=layer.items.find(candidate=>candidate.code===event.target.value);
          if (item!==undefined) controller.choose(item);
        }}>
          <option value="" disabled>请选择</option>
          {options.map(item=><option key={item.code} value={item.code} disabled={!item.navigable}>
            {item.label}{item.nodeKind==="group" ? "（统计分组）" : ""}
          </option>)}
        </select>
        {layer.phase==="loading" ? <LayerFeedback>正在加载第{level}级区域</LayerFeedback> : null}
        {layer.phase==="error" ? <>
          <LayerFeedback>{layer.error ?? `第${level}级区域加载失败`}</LayerFeedback>
          <button type="button" disabled={state.disabled} onClick={()=>void controller.retry(index)}>重试加载第{level}级区域</button>
        </> : null}
        {layer.phase==="loaded" && layer.items.length===0 && layer.parentCode!==null
          ? <LayerFeedback>源快照中该节点无下级区域</LayerFeedback> : null}
        {layer.hasMore ? <button type="button" disabled={state.disabled || layer.phase==="loading"}
          onClick={()=>void controller.loadMore(index)}>加载更多第{level}级区域</button> : null}
        {readOnly ? <LayerFeedback>该层所选区域已停用，只读显示</LayerFeedback> : null}
      </div>;
    })}

    <button type="button" disabled={state.disabled || state.path.length===0} onClick={()=>controller.clear()}>清空选择</button>
    {loadingLevels.length>0 ? <LayerFeedback>正在加载第{loadingLevels.join("、")}级区域</LayerFeedback> : null}
    {currentStatus!==null ? <LayerFeedback>{currentStatus}</LayerFeedback> : null}
  </section>;
}
