"use client";

import {useCallback, useEffect, useId, useState} from "react";
import type {ChangeEvent} from "react";
import {AreaClientError} from "../client/index.js";
import type {AreaAdminClient} from "../client/contracts.js";
import type {DatasetAdminReport, DatasetSummary, Level, RegionSummary} from "../types.js";

export interface AreaManagerProps {
  client: AreaAdminClient;
  className?: string;
}

type LoadPhase="idle"|"loading"|"ready"|"forbidden"|"failed";

function errorCode(error:unknown):string|undefined { return error instanceof AreaClientError ? error.code : undefined; }
function queryMessage(error:unknown):string {
  if (errorCode(error)==="FORBIDDEN") return "无权查看区域管理";
  return "区域查询失败，请重试";
}
function reportText(report:DatasetAdminReport):string {
  const records=typeof report.progress.recordsCommitted==="number" ? `已提交 ${report.progress.recordsCommitted} 条` : "无进度数据";
  return `导入报告：${report.report.passed ? "通过" : "未通过"}；${records}`;
}
function level(value:string):Level|undefined {
  const parsed=Number(value);
  return [1,2,3,4,5].includes(parsed) ? parsed as Level : undefined;
}

/** Small admin UI that reads only one parent page at a time. Authorization remains server-owned. */
export function AreaManager({client,className}:AreaManagerProps):React.JSX.Element {
  const id=useId();
  const [datasets,setDatasets]=useState<DatasetSummary[]>([]);
  const [dataset,setDataset]=useState<DatasetSummary|null>(null);
  const [parent,setParent]=useState<string|null>(null);
  const [path,setPath]=useState<RegionSummary[]>([]);
  const [nodes,setNodes]=useState<RegionSummary[]>([]);
  const [nextCursor,setNextCursor]=useState<string|null>(null);
  const [hasMore,setHasMore]=useState(false);
  const [phase,setPhase]=useState<LoadPhase>("idle");
  const [listError,setListError]=useState<string|null>(null);
  const [nameFilter,setNameFilter]=useState("");
  const [codeFilter,setCodeFilter]=useState("");
  const [levelFilter,setLevelFilter]=useState("");
  const [selected,setSelected]=useState<RegionSummary|null>(null);
  const [displayName,setDisplayName]=useState("");
  const [sort,setSort]=useState("0");
  const [enabled,setEnabled]=useState(true);
  const [saveError,setSaveError]=useState<string|null>(null);
  const [saving,setSaving]=useState(false);
  const [report,setReport]=useState<DatasetAdminReport|null>(null);
  const [reportError,setReportError]=useState<string|null>(null);
  const [loadingReport,setLoadingReport]=useState(false);

  useEffect(()=>{
    let alive=true;
    void (async()=>{
      setPhase("loading");
      try {
        const page=await client.listDatasets({includeUnavailable:true});
        if (!alive) return;
        setDatasets(page.items);
        setDataset(page.items.find(item=>item.isActive) ?? page.items[0] ?? null);
        setPhase("ready");
      } catch(error) {
        if (!alive) return;
        setPhase(errorCode(error)==="FORBIDDEN" ? "forbidden" : "failed");
        setListError(queryMessage(error));
      }
    })();
    return ()=>{alive=false;};
  },[client]);

  const loadNodes=useCallback(async (cursor:string|null,append:boolean):Promise<void>=>{
    if (dataset===null) return;
    setListError(null);
    setPhase("loading");
    try {
      const keyword=(nameFilter.trim() || codeFilter.trim()) || undefined;
      const page=await client.listRegions({datasetId:dataset.datasetId,parentCode:parent,limit:50,
        ...(cursor===null ? {} : {cursor}),...(keyword===undefined ? {} : {keyword}),...(level(levelFilter)===undefined ? {} : {level:level(levelFilter)!})});
      setNodes(previous=>append ? [...previous,...page.items.filter(item=>!previous.some(old=>old.code===item.code))] : page.items);
      setHasMore(page.hasMore);
      setNextCursor(page.nextCursor);
      setPhase("ready");
    } catch(error) {
      setPhase(errorCode(error)==="FORBIDDEN" ? "forbidden" : "failed");
      setListError(queryMessage(error));
    }
  },[client,codeFilter,dataset,levelFilter,nameFilter,parent]);

  useEffect(()=>{
    if (dataset===null) return;
    setNodes([]); setNextCursor(null); setHasMore(false);
    void loadNodes(null,false);
  },[dataset,parent,nameFilter,codeFilter,levelFilter,loadNodes]);

  useEffect(()=>{
    if (selected===null) return;
    setDisplayName(selected.label);
    setSort(String(selected.sort));
    setEnabled(selected.enabled);
    setSaveError(null);
  },[selected]);

  function selectDataset(event:ChangeEvent<HTMLSelectElement>):void {
    const next=datasets.find(item=>item.datasetId===event.target.value) ?? null;
    setDataset(next); setParent(null); setPath([]); setSelected(null); setReport(null); setReportError(null);
  }
  function resetFilters():void { setNameFilter(""); setCodeFilter(""); setLevelFilter(""); }
  async function selectNode(node:RegionSummary):Promise<void> {
    if (dataset===null) return;
    setSelected(node); setSaveError(null);
    try {
      const result=await client.getPath({datasetId:dataset.datasetId,code:node.code});
      setPath(result.nodes);
    } catch(error) { setListError(queryMessage(error)); }
    if (node.hasChildren) setParent(node.code);
  }
  async function save():Promise<void> {
    if (dataset===null || selected===null || saving) return;
    const nextSort=Number(sort);
    if (!Number.isInteger(nextSort)) { setSaveError("排序必须是整数"); return; }
    setSaving(true); setSaveError(null);
    try {
      const saved=await client.updatePresentation({datasetId:dataset.datasetId,code:selected.code,revision:selected.revision,
        patch:{displayName:displayName.trim() || null,sort:nextSort,enabled}});
      setSelected(saved);
      const result=await client.getPath({datasetId:dataset.datasetId,code:saved.code});
      setPath(result.nodes);
      await loadNodes(null,false);
    } catch(error) {
      setSaveError(errorCode(error)==="REVISION_CONFLICT" ? "区域设置已被更新，请重新加载后再保存"
        : errorCode(error)==="FORBIDDEN" ? "无权保存区域展示设置" : "保存区域展示设置失败");
    } finally { setSaving(false); }
  }
  async function loadReport():Promise<void> {
    if (dataset===null || loadingReport) return;
    setLoadingReport(true); setReportError(null);
    try { setReport(await client.getDatasetReport({datasetId:dataset.datasetId})); }
    catch(error) { setReportError(errorCode(error)==="FORBIDDEN" ? "无权查看导入报告" : "读取导入报告失败"); }
    finally { setLoadingReport(false); }
  }
  const visible=nodes.filter(node=>(!nameFilter.trim() || node.label.includes(nameFilter.trim()))
    && (!codeFilter.trim() || node.code.includes(codeFilter.trim())));
  const busy=phase==="loading";

  return <section className={className} aria-busy={busy}>
    <h2>区域管理</h2>
    {phase==="forbidden" ? <p role="alert">无权查看区域管理</p> : null}
    {phase==="failed" && dataset===null ? <p role="alert">{listError}</p> : null}
    {dataset!==null ? <>
      <label htmlFor={`${id}-dataset`}>数据集</label>
      <select id={`${id}-dataset`} value={dataset.datasetId} onChange={selectDataset}>
        {datasets.map(item=><option key={item.datasetId} value={item.datasetId}>{item.versionCode}{item.isActive ? "（当前）" : "（历史）"}</option>)}
      </select>
      <button type="button" onClick={()=>void loadReport()} disabled={loadingReport}>{loadingReport ? "正在读取报告" : "查看导入报告"}</button>
      {report!==null ? <p role="status">{reportText(report)}</p> : null}
      {reportError!==null ? <p role="alert">{reportError}</p> : null}
      <nav aria-label="当前路径">{path.length ? path.map(item=>item.label).join(" / ") : "根区域"}</nav>
      <div>
        <label htmlFor={`${id}-name`}>名称过滤</label><input id={`${id}-name`} value={nameFilter} onChange={event=>setNameFilter(event.target.value)}/>
        <label htmlFor={`${id}-code`}>编码过滤</label><input id={`${id}-code`} value={codeFilter} onChange={event=>setCodeFilter(event.target.value)}/>
        <label htmlFor={`${id}-level`}>层级过滤</label><select id={`${id}-level`} value={levelFilter} onChange={event=>setLevelFilter(event.target.value)}><option value="">全部</option>{[1,2,3,4,5].map(value=><option key={value} value={value}>{value}</option>)}</select>
        <button type="button" onClick={resetFilters}>重置过滤</button>
      </div>
      {listError!==null && dataset!==null ? <><p role="alert">{listError}</p><button type="button" onClick={()=>void loadNodes(null,false)}>重试查询</button></> : null}
      {phase==="loading" ? <p role="status">正在加载区域</p> : null}
      {phase==="ready" && visible.length===0 ? <p>当前条件下没有区域</p> : null}
      <ul aria-label="区域列表">{visible.map(node=><li key={node.code}><button type="button" onClick={()=>void selectNode(node)}>{node.label}（{node.code}）</button>{!node.effectiveEnabled ? "（业务停用）" : ""}</li>)}</ul>
      {hasMore ? <button type="button" onClick={()=>void loadNodes(nextCursor,true)} disabled={busy || nextCursor===null}>加载更多</button> : null}
      {parent!==null ? <button type="button" onClick={()=>{setParent(path.at(-2)?.code ?? null); setPath(path.slice(0,-1));}}>返回上级</button> : null}
      {selected!==null ? <section aria-label="区域详情">
        <h3>{selected.sourceName}（{selected.code}）</h3>
        <p>{path.map(item=>item.label).join(" / ")}</p>
        <label htmlFor={`${id}-display`}>展示名称</label><input id={`${id}-display`} value={displayName} onChange={event=>setDisplayName(event.target.value)}/>
        <label htmlFor={`${id}-sort`}>排序</label><input id={`${id}-sort`} inputMode="numeric" value={sort} onChange={event=>setSort(event.target.value)}/>
        <label htmlFor={`${id}-enabled`}>业务停用</label><input id={`${id}-enabled`} type="checkbox" checked={!enabled} onChange={event=>setEnabled(!event.target.checked)}/>
        {saveError!==null ? <p role="alert">{saveError}</p> : null}
        <button type="button" onClick={()=>void save()} disabled={saving}>{saving ? "正在保存" : "保存展示设置"}</button>
      </section> : null}
    </> : phase==="loading" ? <p role="status">正在加载数据集</p> : null}
  </section>;
}
