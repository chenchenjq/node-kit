// @vitest-environment jsdom
import {cleanup, render, screen, waitFor} from "@testing-library/react";
import {userEvent} from "@testing-library/user-event";
import {useState} from "react";
import {afterEach, expect, it, vi} from "vitest";
import {AreaCascader} from "../src/react/cascader.js";
import type {AreaSelectionClient} from "../src/react/use-area-selection.js";
import {evaluateSelection} from "../src/policy.js";
import type {AreaValue, Page, RegionSummary, SearchHit, VersionSelector} from "../src/types.js";
import {syntheticDataset, syntheticRegion} from "./fixtures/factory.js";

const dataset=syntheticDataset();
const root=syntheticRegion({code:"01",label:"甲省",hasChildren:true,childrenState:"AVAILABLE"});
const group=syntheticRegion({code:"0101",sourceName:"合成统计分组",label:"合成统计分组",level:2,parentCode:"01",nodeKind:"group",selectable:false,
  hasChildren:true,childrenState:"AVAILABLE"});
const county=syntheticRegion({code:"010101",label:"同名县",level:3,parentCode:"0101",hasChildren:false,childrenState:"NONE_IN_SNAPSHOT"});
const alternateDataset=syntheticDataset({datasetId:"00000000-0000-4000-8000-000000000002",versionCode:"synthetic:v2"});
const alternateRoot=syntheticRegion({code:"77",label:"乙省",hasChildren:false,childrenState:"NONE_IN_SNAPSHOT"});

function page(items: RegionSummary[], hasMore=false, nextCursor: string | null=null): Page<RegionSummary> {
  return {datasetId:dataset.datasetId,versionCode:dataset.versionCode,items,hasMore,nextCursor};
}

function searchPage(items: SearchHit[]): Page<SearchHit> {
  return {datasetId:dataset.datasetId,versionCode:dataset.versionCode,items,hasMore:false,nextCursor:null};
}

function pathFor(code: string): RegionSummary[] {
  return code===root.code ? [root] : code===group.code ? [root,group] : [root,group,county];
}

function client(overrides: Partial<AreaSelectionClient> = {}): AreaSelectionClient {
  return {
    getDataset:async()=>dataset,
    listProvinces:async()=>page([root]),
    listChildren:async input=>input.parentCode===root.code ? page([group]) : page([county]),
    getPath:async input=>{const nodes=pathFor(input.code); return {datasetId:dataset.datasetId,versionCode:dataset.versionCode,nodes,pathCodes:nodes.map(node=>node.code),pathNames:nodes.map(node=>node.label)};},
    search:async()=>searchPage([]),
    validateSelection:async input=>evaluateSelection(dataset,pathFor(input.pathCodes.at(-1)!),input),
    ...overrides,
  };
}

afterEach(cleanup);

function Host({selectionClient=client(), targetLevel=3, initialValue=null}: {selectionClient?: AreaSelectionClient; targetLevel?: 1|2|3|4|5; initialValue?: AreaValue|null}) {
  const [value,setValue]=useState<AreaValue|null>(initialValue);
  return <><AreaCascader client={selectionClient} value={value} targetLevel={targetLevel} onChange={next=>setValue(next)} />
    <output aria-label="当前代码">{value?.code ?? ""}</output></>;
}

it("keeps a source group navigable and explains endpoint restrictions", async () => {
  const user=userEvent.setup();
  render(<Host targetLevel={2} />);
  await user.selectOptions(await screen.findByLabelText("第1级区域"),root.code);
  await user.selectOptions(await screen.findByLabelText("第2级区域"),group.code);
  expect(await screen.findByText("统计导航分组不能作为当前选择终点")).not.toBeNull();
  expect(screen.getByLabelText("当前代码").textContent).toBe(group.code);
  expect((screen.getByRole("option",{name:"合成统计分组（统计分组）"}) as HTMLOptionElement).disabled).toBe(false);
});

it("uses persistent native labels, clears a controlled value, and caps layers by source target level", async () => {
  const user=userEvent.setup();
  render(<Host targetLevel={1} />);
  const province=await screen.findByLabelText("第1级区域");
  await user.selectOptions(province,root.code);
  expect(screen.queryByLabelText("第2级区域")).toBeNull();
  await user.click(screen.getByRole("button",{name:"清空选择"}));
  await waitFor(()=>expect(screen.getByLabelText("当前代码").textContent).toBe(""));
});

it("shows full search paths and closes search results with Escape", async () => {
  const hit: SearchHit={...county,pathCodes:[root.code,group.code,county.code],pathNames:[root.label,group.label,county.label]};
  const user=userEvent.setup();
  render(<Host selectionClient={client({search:async()=>searchPage([hit])})} />);
  const search=await screen.findByLabelText("搜索区域");
  await user.type(search,"同名");
  await user.click(screen.getByRole("button",{name:"搜索"}));
  expect(await screen.findByRole("button",{name:/甲省.*合成统计分组.*同名县.*010101/})).not.toBeNull();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("button",{name:/甲省.*合成统计分组.*同名县/})).toBeNull();
});

it("searches from an enclosing form without submitting that form", async () => {
  const hit: SearchHit={...county,pathCodes:[root.code,group.code,county.code],pathNames:[root.label,group.label,county.label]};
  const submit=vi.fn();
  const user=userEvent.setup();
  render(<form onSubmit={submit}><AreaCascader client={client({search:async()=>searchPage([hit])})} value={null} onChange={()=>{}} /></form>);
  await user.type(await screen.findByLabelText("搜索区域"),"同名");
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("button",{name:/甲省.*同名县.*010101/})).not.toBeNull();
  expect(submit).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button",{name:"搜索"}));
  expect(submit).not.toHaveBeenCalled();
});

it("clears search hits from a previous controlled dataset before they can resolve against the new dataset", async () => {
  const hit: SearchHit={...county,pathCodes:[root.code,group.code,county.code],pathNames:[root.label,group.label,county.label]};
  const getPath=vi.fn(async (input: VersionSelector & {code: string})=>{
    const nodes=input.code===alternateRoot.code ? [alternateRoot] : pathFor(input.code);
    const selectedDataset=input.datasetId===alternateDataset.datasetId ? alternateDataset : dataset;
    return {datasetId:selectedDataset.datasetId,versionCode:selectedDataset.versionCode,nodes,pathCodes:nodes.map(node=>node.code),pathNames:nodes.map(node=>node.label)};
  });
  const selectionClient=client({
    getDataset:async (input={})=>input.datasetId===alternateDataset.datasetId ? alternateDataset : dataset,
    getPath,
    search:async()=>searchPage([hit]),
  });
  function SwitchingHost() {
    const [value,setValue]=useState<AreaValue|null>(null);
    return <><button type="button" onClick={()=>setValue({datasetId:alternateDataset.datasetId,code:alternateRoot.code})}>切换数据集</button>
      <AreaCascader client={selectionClient} value={value} onChange={setValue} /></>;
  }
  const user=userEvent.setup();
  render(<SwitchingHost />);
  await user.type(await screen.findByLabelText("搜索区域"),"同名");
  await user.click(screen.getByRole("button",{name:"搜索"}));
  expect(await screen.findByRole("button",{name:/甲省.*同名县.*010101/})).not.toBeNull();
  getPath.mockClear();
  await user.click(screen.getByRole("button",{name:"切换数据集"}));
  await waitFor(()=>expect(screen.queryByRole("button",{name:/甲省.*同名县.*010101/})).toBeNull());
  expect(getPath).not.toHaveBeenCalledWith(expect.objectContaining({datasetId:alternateDataset.datasetId,code:county.code}),expect.any(AbortSignal));
});

it("offers retry and load-more controls for their corresponding layer state", async () => {
  const user=userEvent.setup();
  const listChildren=vi.fn()
    .mockRejectedValueOnce(new Error("暂时离线"))
    .mockRejectedValueOnce(new Error("暂时离线"))
    .mockResolvedValueOnce(page([group],true,"next"))
    .mockResolvedValueOnce(page([group,syntheticRegion({code:"0102",label:"乙市",level:2,parentCode:"01"})]));
  render(<Host selectionClient={client({listChildren,validateSelection:async input=>evaluateSelection(dataset,pathFor(input.pathCodes.at(-1)!),input)})} />);
  await user.selectOptions(await screen.findByLabelText("第1级区域"),root.code);
  await user.click(await screen.findByRole("button",{name:"重试加载第2级区域"}));
  await user.click(await screen.findByRole("button",{name:"加载更多第2级区域"}));
  await waitFor(()=>expect(listChildren).toHaveBeenCalledTimes(4));
});
