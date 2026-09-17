"use client";

import {useMemo} from "react";
import {AreaManager} from "area-kit/react";
import {createBrowserAreaClient} from "../../../lib/client.js";

export default function AdminAreasPage(): React.JSX.Element {
  const client=useMemo(()=>createBrowserAreaClient(),[]);
  return <main><h1>区域管理</h1><AreaManager client={client}/></main>;
}
