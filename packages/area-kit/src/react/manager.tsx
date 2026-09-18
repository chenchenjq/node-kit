"use client";

import {useCallback, useEffect, useId, useRef, useState} from "react";
import type {ChangeEvent} from "react";
import {AreaClientError} from "../client/index.js";
import type {AreaAdminClient} from "../client/contracts.js";
import type {DatasetAdminReport, DatasetSummary, Level, Page, RegionSummary, SearchHit} from "../types.js";

export interface AreaManagerProps { client: AreaAdminClient; className?: string; }
type LoadPhase="idle"|"loading"|"ready"|"forbidden"|"failed";
interface QueryContext { dataset:DatasetSummary; parentCode:string|null; parentLevel:Level|null; keyword:string; level:Level|undefined; }

function errorCode(error:unknown):string|undefined { return error instanceof AreaClientError ? error.code : undefined; }
function isAbort(error:unknown):boolean { return typeof error==="object" && error!==null && "name" in error && error.name==="AbortError"; }
function queryMessage(error:unknown):string { return errorCode(error)==="FORBIDDEN" ? "无权查看区域管理" : "区域查询失败，请重试"; }
function level(value:string):Level|undefined { const parsed=Number(value); return [1,2,3,4,5].includes(parsed) ? parsed as Level : undefined; }
function coverageText(dataset:DatasetSummary):string {
  const levels=dataset.coverage.levels.map(value=>`第${value}级`).join("、") || "无层级";
  const excluded=dataset.coverage.excluded.length ? `；排除 ${dataset.coverage.excluded.join("、")}` : "";
  return `覆盖范围：${levels}；${dataset.coverage.description}${excluded}`;
}
function reportText(report:DatasetAdminReport):string {
  const records=typeof report.progress.recordsCommitted==="number" ? `已提交 ${report.progress.recordsCommitted} 条` : "无进度数据";
  const summary=Object.values(report.report.counts).reduce((total,count)=>({input:total.input+count.input,valid:total.valid+count.valid,
    invalid:total.invalid+count.invalid+count.conflict+count.missingParent+count.ancestorMismatch}),{input:0,valid:0,invalid:0});
  return `导入报告：${report.report.passed ? "通过" : "未通过"}；${records}；汇总 ${summary.input} 条，${summary.valid} 条有效，${summary.invalid} 条异常`;
}

/** Small admin UI that reads one query page at a time. Authorization remains server-owned. */
export function AreaManager({client,className}:AreaManagerProps):React.JSX.Element {
  const id=useId(), generation=useRef(0), controllers=useRef(new Set<AbortController>()), selectionRequest=useRef(0);
  const selectionController=useRef<AbortController|null>(null);
  const [datasets,setDatasets]=useState<DatasetSummary[]>([]), [dataset,setDataset]=useState<DatasetSummary|null>(null);
  const [navigationParent,setNavigationParent]=useState<string|null>(null), [navigationPath,setNavigationPath]=useState<RegionSummary[]>([]);
  const [detailPath,setDetailPath]=useState<RegionSummary[]>([]), [nodes,setNodes]=useState<RegionSummary[]>([]);
  const [nextCursor,setNextCursor]=useState<string|null>(null), [currentCursor,setCurrentCursor]=useState<string|null>(null);
  const [hasMore,setHasMore]=useState(false), [phase,setPhase]=useState<LoadPhase>("idle");
  const [listError,setListError]=useState<string|null>(null), [nameFilter,setNameFilter]=useState(""), [codeFilter,setCodeFilter]=useState(""), [levelFilter,setLevelFilter]=useState("");
  const [selected,setSelected]=useState<RegionSummary|null>(null), [displayName,setDisplayName]=useState(""), [sort,setSort]=useState("0"), [enabled,setEnabled]=useState(true);
  const [saveError,setSaveError]=useState<string|null>(null), [saving,setSaving]=useState(false), [report,setReport]=useState<DatasetAdminReport|null>(null);
  const [reportError,setReportError]=useState<string|null>(null), [loadingReport,setLoadingReport]=useState(false);

  const nextGeneration=useCallback(()=>{
    generation.current++; selectionRequest.current++; selectionController.current?.abort(); selectionController.current=null;
    for (const controller of controllers.current) controller.abort(); controllers.current.clear();
    setSaving(false); setLoadingReport(false);
    return generation.current;
  },[]);
  const request=useCallback((expected:number):AbortController|null=>{
    if (generation.current!==expected) return null;
    const controller=new AbortController(); controllers.current.add(controller); return controller;
  },[]);
  const release=useCallback((controller:AbortController)=>{ controllers.current.delete(controller); },[]);
  const current=useCallback((value:number)=>generation.current===value,[]);
  const makeQuery=useCallback((selectedDataset:DatasetSummary):QueryContext=>({dataset:selectedDataset,parentCode:navigationParent,
    parentLevel:navigationPath.at(-1)?.level ?? null,keyword:nameFilter.trim() || codeFilter.trim(),level:level(levelFilter)}),
  [codeFilter,levelFilter,nameFilter,navigationParent,navigationPath]);

  const loadNodes=useCallback(async (context:QueryContext,cursor:string|null,append:boolean,expected:number):Promise<void>=>{
    const controller=request(expected); if (controller===null) return;
    setListError(null); setPhase("loading");
    try {
      const scopedLevel=context.level!==undefined && (context.parentLevel===null || context.level>context.parentLevel) ? context.level : undefined;
      let page:Page<RegionSummary>;
      if (context.keyword) {
        const result:Page<SearchHit>=await client.search({datasetId:context.dataset.datasetId,keyword:context.keyword,...(cursor===null ? {} : {cursor}),
          ...(scopedLevel===undefined ? {} : {level:scopedLevel}),...(context.parentCode===null ? {} : {ancestorCode:context.parentCode})},controller.signal);
        page=result;
      } else {
        const input={datasetId:context.dataset.datasetId,...(cursor===null ? {} : {cursor}),...(scopedLevel===undefined ? {} : {level:scopedLevel}),
          ...(context.parentCode!==null ? scopedLevel===undefined ? {parentCode:context.parentCode} : {ancestorCode:context.parentCode}
            : scopedLevel===undefined || scopedLevel===1 ? {parentCode:null} : {})};
        page=await client.listRegions(input,controller.signal);
      }
      if (!current(expected)) return;
      setNodes(previous=>append ? [...previous,...page.items.filter(item=>!previous.some(old=>old.code===item.code))] : page.items);
      setHasMore(page.hasMore); setNextCursor(page.nextCursor); setCurrentCursor(cursor); setPhase("ready");
    } catch(error) {
      if (!current(expected) || isAbort(error)) return;
      setPhase(errorCode(error)==="FORBIDDEN" ? "forbidden" : "failed"); setListError(queryMessage(error));
    } finally { release(controller); }
  },[client,current,release,request]);

  useEffect(()=>{
    const expected=nextGeneration(), controller=request(expected); if (controller===null) return;
    setPhase("loading"); setDataset(null); setNodes([]); setReport(null); setReportError(null);
    void (async()=>{ try {
      const page=await client.listDatasets({includeUnavailable:true},controller.signal);
      if (!current(expected)) return;
      setDatasets(page.items); setDataset(page.items.find(item=>item.isActive) ?? page.items[0] ?? null); setPhase("ready");
    } catch(error) {
      if (!current(expected) || isAbort(error)) return;
      setPhase(errorCode(error)==="FORBIDDEN" ? "forbidden" : "failed"); setListError(queryMessage(error));
    } finally { release(controller); } })();
  },[client,current,nextGeneration,release,request]);

  useEffect(()=>{
    if (dataset===null) return;
    const expected=nextGeneration(); setNodes([]); setNextCursor(null); setCurrentCursor(null); setHasMore(false);
    void loadNodes(makeQuery(dataset),null,false,expected);
  },[dataset,navigationParent,navigationPath,codeFilter,levelFilter,nameFilter,loadNodes,makeQuery,nextGeneration]);
  useEffect(()=>{ if (selected!==null) { setDisplayName(selected.label); setSort(String(selected.sort)); setEnabled(selected.enabled); setSaveError(null); } },[selected]);

  function selectDataset(event:ChangeEvent<HTMLSelectElement>):void {
    nextGeneration(); const next=datasets.find(item=>item.datasetId===event.target.value) ?? null;
    setDataset(next); setNavigationParent(null); setNavigationPath([]); setDetailPath([]); setSelected(null); setReport(null); setReportError(null);
  }
  function resetFilters():void { setNameFilter(""); setCodeFilter(""); setLevelFilter(""); }
  function changeNameFilter(value:string):void { setNameFilter(value); if (value) setCodeFilter(""); }
  function changeCodeFilter(value:string):void { setCodeFilter(value); if (value) setNameFilter(""); }
  async function selectNode(node:RegionSummary):Promise<void> {
    if (dataset===null) return;
    const selection=++selectionRequest.current;
    selectionController.current?.abort(); selectionController.current=null;
    const selectedDataset=dataset, expected=generation.current, controller=request(expected); if (controller===null) return;
    selectionController.current=controller;
    setSelected(node); setSaveError(null);
    try {
      const result=await client.getPath({datasetId:selectedDataset.datasetId,code:node.code},controller.signal);
      if (!current(expected) || selectionRequest.current!==selection) return;
      setDetailPath(result.nodes);
      if (node.hasChildren) { setNavigationPath(result.nodes); setNavigationParent(node.code); }
    } catch(error) { if (current(expected) && selectionRequest.current===selection && !isAbort(error)) setListError(queryMessage(error)); }
    finally { release(controller); if (selectionController.current===controller) selectionController.current=null; }
  }
  function returnToParent():void { nextGeneration(); setNavigationParent(navigationPath.at(-2)?.code ?? null); setNavigationPath(previous=>previous.slice(0,-1)); }
  async function save():Promise<void> {
    if (dataset===null || selected===null || saving) return;
    const nextSort=Number(sort); if (!Number.isInteger(nextSort)) { setSaveError("排序必须是整数"); return; }
    const selectedDataset=dataset, selectedNode=selected, expected=generation.current, selection=selectionRequest.current, controller=request(expected); if (controller===null) return;
    setSaving(true); setSaveError(null);
    try {
      const saved=await client.updatePresentation({datasetId:selectedDataset.datasetId,code:selectedNode.code,revision:selectedNode.revision,
        patch:{displayName:displayName.trim() || null,sort:nextSort,enabled}},controller.signal);
      if (!current(expected) || selectionRequest.current!==selection) return;
      setSelected(saved);
      const result=await client.getPath({datasetId:selectedDataset.datasetId,code:saved.code},controller.signal);
      if (!current(expected) || selectionRequest.current!==selection) return;
      setDetailPath(result.nodes); await loadNodes(makeQuery(selectedDataset),currentCursor,false,expected);
    } catch(error) {
      if (!current(expected) || selectionRequest.current!==selection || isAbort(error)) return;
      setSaveError(errorCode(error)==="REVISION_CONFLICT" ? "区域设置已被更新，请重新加载后再保存"
        : errorCode(error)==="FORBIDDEN" ? "无权保存区域展示设置" : "保存区域展示设置失败");
    } finally { release(controller); if (current(expected)) setSaving(false); }
  }
  async function loadReport():Promise<void> {
    if (dataset===null || loadingReport) return;
    const selectedDataset=dataset, expected=generation.current, controller=request(expected); if (controller===null) return;
    setLoadingReport(true); setReportError(null);
    try { const result=await client.getDatasetReport({datasetId:selectedDataset.datasetId},controller.signal); if (current(expected)) setReport(result); }
    catch(error) { if (current(expected) && !isAbort(error)) setReportError(errorCode(error)==="FORBIDDEN" ? "无权查看导入报告" : "读取导入报告失败"); }
    finally { release(controller); if (current(expected)) setLoadingReport(false); }
  }
  const busy=phase==="loading";

  return <section className={className} aria-busy={busy}>
    <h2>区域管理</h2>
    {phase==="forbidden" ? <p role="alert">无权查看区域管理</p> : null}
    {phase==="failed" && dataset===null ? <p role="alert">{listError}</p> : null}
    {dataset!==null ? <>
      <label htmlFor={`${id}-dataset`}>数据集</label><select id={`${id}-dataset`} value={dataset.datasetId} onChange={selectDataset}>
        {datasets.map(item=><option key={item.datasetId} value={item.datasetId}>{item.versionCode}{item.isActive ? "（当前）" : "（历史）"}</option>)}</select>
      <p>{coverageText(dataset)}</p>
      <button type="button" onClick={()=>void loadReport()} disabled={loadingReport}>{loadingReport ? "正在读取报告" : "查看导入报告"}</button>
      {report!==null ? <p role="status">{reportText(report)}</p> : null}{reportError!==null ? <p role="alert">{reportError}</p> : null}
      <nav aria-label="当前路径">{navigationPath.length ? navigationPath.map(item=>item.label).join(" / ") : "根区域"}</nav>
      <div>
        <label htmlFor={`${id}-name`}>名称过滤</label><input id={`${id}-name`} value={nameFilter} onChange={event=>changeNameFilter(event.target.value)}/>
        <label htmlFor={`${id}-code`}>编码过滤</label><input id={`${id}-code`} value={codeFilter} onChange={event=>changeCodeFilter(event.target.value)}/>
        <label htmlFor={`${id}-level`}>层级过滤</label><select id={`${id}-level`} value={levelFilter} onChange={event=>setLevelFilter(event.target.value)}><option value="">全部</option>{[1,2,3,4,5].map(value=><option key={value} value={value}>{value}</option>)}</select>
        <button type="button" onClick={resetFilters}>重置过滤</button>
      </div>
      {listError!==null ? <><p role="alert">{listError}</p><button type="button" onClick={()=>void loadNodes(makeQuery(dataset),null,false,generation.current)}>重试查询</button></> : null}
      {phase==="loading" ? <p role="status">正在加载区域</p> : null}{phase==="ready" && nodes.length===0 ? <p>当前条件下没有区域</p> : null}
      <ul aria-label="区域列表">{nodes.map(node=><li key={node.code}><button type="button" onClick={()=>void selectNode(node)}>{node.label}（{node.code}）</button>{!node.effectiveEnabled ? "（业务停用）" : ""}</li>)}</ul>
      {hasMore ? <button type="button" onClick={()=>void loadNodes(makeQuery(dataset),nextCursor,true,generation.current)} disabled={busy || nextCursor===null}>加载更多</button> : null}
      {navigationParent!==null ? <button type="button" onClick={returnToParent}>返回上级</button> : null}
      {selected!==null ? <section aria-label="区域详情"><h3>{selected.sourceName}（{selected.code}）</h3><p>{detailPath.map(item=>item.label).join(" / ")}</p>
        <label htmlFor={`${id}-display`}>展示名称</label><input id={`${id}-display`} value={displayName} onChange={event=>setDisplayName(event.target.value)}/>
        <label htmlFor={`${id}-sort`}>排序</label><input id={`${id}-sort`} inputMode="numeric" value={sort} onChange={event=>setSort(event.target.value)}/>
        <label htmlFor={`${id}-enabled`}>业务停用</label><input id={`${id}-enabled`} type="checkbox" checked={!enabled} onChange={event=>setEnabled(!event.target.checked)}/>
        {saveError!==null ? <p role="alert">{saveError}</p> : null}<button type="button" onClick={()=>void save()} disabled={saving}>{saving ? "正在保存" : "保存展示设置"}</button>
      </section> : null}
    </> : phase==="loading" ? <p role="status">正在加载数据集</p> : null}
  </section>;
}
