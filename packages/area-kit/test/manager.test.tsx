// @vitest-environment jsdom
import {cleanup, render, screen, waitFor, within} from "@testing-library/react";
import {userEvent} from "@testing-library/user-event";
import {afterEach, expect, it, vi} from "vitest";
import {AreaClientError} from "../src/client/index.js";
import {AreaManager} from "../src/react/manager.js";
import type {AreaAdminClient} from "../src/client/contracts.js";
import type {DatasetAdminReport, DatasetSummary, Page, RegionSummary} from "../src/types.js";
import {syntheticDataset, syntheticRegion} from "./fixtures/factory.js";

const dataset=syntheticDataset();
const root=syntheticRegion({code:"01",label:"甲省",hasChildren:true,childrenState:"AVAILABLE"});
const child=syntheticRegion({code:"0101",label:"甲市",level:2,parentCode:"01"});
const page=(items:RegionSummary[],hasMore=false,nextCursor:string|null=null):Page<RegionSummary>=>({datasetId:dataset.datasetId,versionCode:dataset.versionCode,items,hasMore,nextCursor});
function deferred<T>() { let resolve!:(value:T)=>void; const promise=new Promise<T>(next=>{resolve=next;}); return {promise,resolve}; }

function client(overrides:Partial<AreaAdminClient>={}):AreaAdminClient {
  return {
    getDataset:async()=>dataset,
    listDatasets:async()=>({items:[dataset],hasMore:false,nextCursor:null}),
    listProvinces:async()=>page([root]),
    listChildren:async()=>page([child]),
    listRegions:async input=>input.parentCode===root.code ? page([child]) : page([root]),
    getRegion:async input=>input.code===child.code ? child : root,
    getRegions:async()=>({datasetId:dataset.datasetId,versionCode:dataset.versionCode,items:[],missingCodes:[]}),
    getPath:async input=>{const nodes=input.code===child.code?[root,child]:[root];return {datasetId:dataset.datasetId,versionCode:dataset.versionCode,nodes,pathCodes:nodes.map(node=>node.code),pathNames:nodes.map(node=>node.label)};},
    search:async()=>({datasetId:dataset.datasetId,versionCode:dataset.versionCode,items:[],hasMore:false,nextCursor:null}),
    getTree:async()=>({datasetId:dataset.datasetId,versionCode:dataset.versionCode,items:[]}),
    validateSelection:async()=>({datasetId:dataset.datasetId,versionCode:dataset.versionCode,code:null,level:null,actualLevel:null,pathCodes:null,pathNames:null,candidatePathCodes:[],targetLevel:3,reachedTargetLevel:false,accepted:false,reason:"UNKNOWN_CODE"}),
    updatePresentation:async()=>root,
    getDatasetReport:async()=>({datasetId:dataset.datasetId,versionCode:dataset.versionCode,progress:{recordsCommitted:1},report:{passed:true,counts:{1:{input:1,valid:1,duplicate:0,conflict:0,missingParent:0,ancestorMismatch:0,invalid:0},2:{input:0,valid:0,duplicate:0,conflict:0,missingParent:0,ancestorMismatch:0,invalid:0},3:{input:0,valid:0,duplicate:0,conflict:0,missingParent:0,ancestorMismatch:0,invalid:0},4:{input:0,valid:0,duplicate:0,conflict:0,missingParent:0,ancestorMismatch:0,invalid:0},5:{input:0,valid:0,duplicate:0,conflict:0,missingParent:0,ancestorMismatch:0,invalid:0}},issuesPath:null,samples:[],digestAlgorithm:"sha256",sourceDigests:{1:"x",2:"x",3:"x",4:"x",5:"x"},databaseDigests:{},inheritanceConflicts:0}}),
    ...overrides,
  };
}

afterEach(cleanup);

it("navigates one parent at a time, reads selected ancestry, and never loads a tree",async()=>{
  const getTree=vi.fn();
  render(<AreaManager client={client({getTree})}/>);
  const user=userEvent.setup();
  await user.click(await screen.findByRole("button",{name:/甲省/}));
  await user.click(await screen.findByRole("button",{name:/甲市/}));
  await waitFor(()=>expect(screen.getByRole("navigation",{name:"当前路径"}).textContent).toBe("甲省"));
  expect(within(screen.getByLabelText("区域详情")).getByText("甲省 / 甲市")).not.toBeNull();
  expect(getTree).not.toHaveBeenCalled();
});

it("keeps edits after a revision conflict and exposes a separate forbidden state",async()=>{
  const user=userEvent.setup();
  const updatePresentation=vi.fn(async()=>{throw new AreaClientError("REVISION_CONFLICT");});
  render(<AreaManager client={client({updatePresentation})}/>);
  await user.click(await screen.findByRole("button",{name:/甲省/}));
  await user.clear(screen.getByLabelText("展示名称"));
  await user.type(screen.getByLabelText("展示名称"),"新别名");
  await user.click(screen.getByRole("button",{name:"保存展示设置"}));
  expect(await screen.findByText("区域设置已被更新，请重新加载后再保存")).not.toBeNull();
  expect((screen.getByLabelText("展示名称") as HTMLInputElement).value).toBe("新别名");
  cleanup();
  render(<AreaManager client={client({listDatasets:async()=>{throw new AreaClientError("FORBIDDEN");}})}/>);
  expect(await screen.findByText("无权查看区域管理")).not.toBeNull();
});

it("loads reports only when requested and treats disabled as a business setting",async()=>{
  const getDatasetReport=vi.fn(client().getDatasetReport);
  const user=userEvent.setup();
  render(<AreaManager client={client({getDatasetReport})}/>);
  await screen.findByRole("button",{name:/甲省/});
  expect(screen.getByText(/覆盖范围：第1级/)).not.toBeNull();
  expect(getDatasetReport).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button",{name:"查看导入报告"}));
  expect(await screen.findByText(/导入报告：通过.*汇总 1 条/)).not.toBeNull();
  await user.click(screen.getByRole("button",{name:/甲省/}));
  await user.click(screen.getByLabelText("业务停用"));
  expect(screen.queryByText("行政撤销")).toBeNull();
});

it("retries a failed query and starts filtered pages from the first cursor",async()=>{
  const listRegions=vi.fn()
    .mockRejectedValueOnce(new AreaClientError("QUERY_FAILED"))
    .mockResolvedValue(page([root],true,"next"));
  const search=vi.fn().mockResolvedValue({datasetId:dataset.datasetId,versionCode:dataset.versionCode,items:[],hasMore:false,nextCursor:null});
  const user=userEvent.setup();
  render(<AreaManager client={client({listRegions,search})}/>);
  await user.click(await screen.findByRole("button",{name:"重试查询"}));
  await user.click(await screen.findByRole("button",{name:"加载更多"}));
  await user.type(screen.getByLabelText("编码过滤"),"01");
  await waitFor(()=>expect(search.mock.calls.at(-1)?.[0]).toMatchObject({keyword:"01"}));
  expect(search.mock.calls.at(-1)?.[0]).not.toHaveProperty("cursor");
});

it("uses paginated server search for name or code filters instead of filtering the first node page",async()=>{
  const hit={...child,pathCodes:[root.code,child.code],pathNames:[root.label,child.label]};
  const search=vi.fn().mockResolvedValue({datasetId:dataset.datasetId,versionCode:dataset.versionCode,items:[hit],hasMore:true,nextCursor:"search-next"});
  const user=userEvent.setup();
  render(<AreaManager client={client({search})}/>);
  await user.type(await screen.findByLabelText("编码过滤"),"0101");
  expect(await screen.findByRole("button",{name:/甲市/})).not.toBeNull();
  expect(search).toHaveBeenLastCalledWith(expect.objectContaining({datasetId:dataset.datasetId,keyword:"0101"}),expect.any(AbortSignal));
  await user.click(screen.getByRole("button",{name:"加载更多"}));
  await waitFor(()=>expect(search).toHaveBeenLastCalledWith(expect.objectContaining({cursor:"search-next"}),expect.any(AbortSignal)));
});

it("omits root parentCode when a non-root level filter searches the dataset",async()=>{
  const listRegions=vi.fn(client().listRegions);
  const user=userEvent.setup();
  render(<AreaManager client={client({listRegions})}/>);
  await user.selectOptions(await screen.findByLabelText("层级过滤"),"2");
  await waitFor(()=>expect(listRegions.mock.calls.at(-1)?.[0]).toMatchObject({datasetId:dataset.datasetId,level:2}));
  expect(listRegions.mock.calls.at(-1)?.[0]).not.toHaveProperty("parentCode");
});

it("ignores stale node and report responses after a dataset switch",async()=>{
  const historical=syntheticDataset({datasetId:"00000000-0000-4000-8000-000000000002",versionCode:"old:v1",isActive:false});
  const staleNodes=deferred<Page<RegionSummary>>();
  const staleReport=deferred<DatasetAdminReport>();
  const listRegions=vi.fn((input:{datasetId?:string})=>input.datasetId===dataset.datasetId ? staleNodes.promise : Promise.resolve({datasetId:historical.datasetId,versionCode:historical.versionCode,items:[syntheticRegion({code:"99",label:"旧省"})],hasMore:false,nextCursor:null}));
  const getDatasetReport=vi.fn((input:{datasetId?:string})=>input.datasetId===dataset.datasetId ? staleReport.promise : client().getDatasetReport(input));
  const user=userEvent.setup();
  render(<AreaManager client={client({listDatasets:async()=>({items:[dataset,historical],hasMore:false,nextCursor:null}),listRegions,getDatasetReport})}/>);
  await user.click(await screen.findByRole("button",{name:"查看导入报告"}));
  await user.selectOptions(await screen.findByLabelText("数据集"),historical.datasetId);
  staleNodes.resolve(page([root]));
  staleReport.resolve(await client().getDatasetReport({datasetId:dataset.datasetId}));
  expect(await screen.findByRole("button",{name:/旧省/})).not.toBeNull();
  await waitFor(()=>expect(screen.queryByText(/导入报告：通过/)).toBeNull());
});

it("keeps selected-detail ancestry independent from parent navigation",async()=>{
  const user=userEvent.setup();
  render(<AreaManager client={client()}/>);
  await user.click(await screen.findByRole("button",{name:/甲省/}));
  await user.click(await screen.findByRole("button",{name:/甲市/}));
  await user.click(screen.getByRole("button",{name:"返回上级"}));
  await waitFor(()=>expect(screen.getByRole("navigation",{name:"当前路径"}).textContent).toBe("根区域"));
  expect(within(screen.getByLabelText("区域详情")).getByText("甲省 / 甲市")).not.toBeNull();
});
