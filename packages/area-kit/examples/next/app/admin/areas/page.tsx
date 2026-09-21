"use client";

import {useMemo} from "react";
import {AreaManager} from "area-kit/react";
import {createBrowserAreaClient} from "../../../lib/client.js";

export default function AdminAreasPage(): React.JSX.Element {
  const client=useMemo(()=>createBrowserAreaClient(),[]);
  return <main><h1>区域管理</h1><p>查看区域版本，调整展示名称、排序和可选状态。</p><AreaManager client={client}/></main>;
}
