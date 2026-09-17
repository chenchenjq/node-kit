"use client";

import {useMemo, useState} from "react";
import {AreaCascader} from "area-kit/react";
import type {AreaValue, SelectionResult} from "area-kit";
import {createBrowserAreaClient} from "../../lib/client.js";

export default function AreasPage(): React.JSX.Element {
  const client=useMemo(()=>createBrowserAreaClient(),[]);
  const [value,setValue]=useState<AreaValue | null>(null);
  const [status,setStatus]=useState<SelectionResult | null>(null);

  return <main>
    <h1>区域选择</h1>
    <AreaCascader client={client} value={value} onChange={setValue} onStatus={setStatus} />
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
