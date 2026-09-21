"use client";

import {useMemo, useState} from "react";
import {AreaCascader} from "area-kit/react";
import type {AreaValue, SelectionResult} from "area-kit";
import {createBrowserAreaClient} from "../../lib/client.js";

export default function AreasPage(): React.JSX.Element {
  const client=useMemo(()=>createBrowserAreaClient(),[]);
  const [value,setValue]=useState<AreaValue | null>(null);
  const [status,setStatus]=useState<SelectionResult | null>(null);

  const [submitting,setSubmitting]=useState(false);
  const [message,setMessage]=useState("");
  async function submit() {
    if (!value || !value.pathCodes?.length || submitting) return;
    setSubmitting(true); setMessage("");
    try {
      const response=await fetch("/api/address-selection", {method:"POST", headers:{"content-type":"application/json"},
        body:JSON.stringify({datasetId:value.datasetId,pathCodes:value.pathCodes})});
      const body=await response.json() as {data?: {pathNames: string[]}; error?: {message: string}};
      setMessage(response.ok && body.data ? `已保存：${body.data.pathNames.join(" / ")}` : body.error?.message ?? "提交失败，请重试");
    } catch { setMessage("提交失败，请检查连接后重试"); }
    finally { setSubmitting(false); }
  }

  return <main>
    <h1>区域选择</h1>
    <AreaCascader client={client} value={value} targetLevel={3}
      onChange={(nextValue)=>setValue(nextValue)} onStatus={setStatus} />
    <p><button type="button" disabled={submitting || !value?.pathCodes?.length || !status?.accepted} onClick={()=>{void submit();}}>{submitting ? "正在保存…" : "保存地址"}</button></p>
    <p role="status">{message}</p>
    <h2>当前受控值</h2>
    <pre>{JSON.stringify(value,null,2)}</pre>
    <h2>当前校验状态</h2>
    <pre>{JSON.stringify(status===null ? null : {
      datasetId:status.datasetId,
      code:status.code,
      actualLevel:status.actualLevel,
      reachedTargetLevel:status.reachedTargetLevel,
      accepted:status.accepted,
      reason:status.reason,
    },null,2)}</pre>
  </main>;
}
