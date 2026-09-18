import {expect, it} from "vitest";
import * as area from "../src/index.js";
import {createAreaKit} from "../src/server/index.js";
import type {AreaStore} from "../src/server/ports.js";
import type {Level, RegionSummary, ValidationInput} from "../src/types.js";
import {syntheticDataset, syntheticRegion} from "./fixtures/factory.js";

const dataset = syntheticDataset();
const path = [1,2,3,4,5].map((level, index) => syntheticRegion({
  code: "01".repeat(level), level: level as Level,
  parentCode: index ? "01".repeat(index) : null, nodeKind: "region",
  hasChildren: level < 5, childrenState: level < 5 ? "AVAILABLE" : "NONE_IN_SNAPSHOT",
}));
function input(nodes: readonly RegionSummary[], targetLevel: Level = 3): ValidationInput {
  return {pathCodes: nodes.map(node => node.code), targetLevel};
}

it("does not accept a navigation group through early termination", () => {
  const nodes = [path[0]!, syntheticRegion({code:"0101",level:2,parentCode:"01",nodeKind:"group",selectable:false})];
  expect(area.evaluateSelection(dataset,nodes,input(nodes),{policy:{allowEarlyTermination:true}}))
    .toMatchObject({accepted:false,reason:"NAVIGATION_ONLY",actualLevel:2,reachedTargetLevel:false});
});

it.each([1,2,3,4,5] as const)("accepts exactly target level %s and returns the authoritative path", target => {
  const nodes=path.slice(0,target);
  expect(area.evaluateSelection(dataset,nodes,input(nodes,target))).toMatchObject({
    accepted:true,reason:"TARGET_REACHED",targetLevel:target,actualLevel:target,reachedTargetLevel:true,
    pathCodes:nodes.map(n=>n.code),pathNames:nodes.map(n=>n.label),datasetId:dataset.datasetId,
  });
});

it("defaults to level 3 and strict policy, and only explicitly permits a snapshot leaf", () => {
  const leaf=[{...path[0]!,hasChildren:false,childrenState:"NONE_IN_SNAPSHOT" as const}];
  expect(area.evaluateSelection(dataset,leaf,{pathCodes:["01"]})).toMatchObject({accepted:false,reason:"TARGET_LEVEL_NOT_REACHED",targetLevel:3});
  expect(area.evaluateSelection(dataset,leaf,input(leaf),{policy:{allowEarlyTermination:true}}))
    .toMatchObject({accepted:true,reason:"EARLY_TERMINATION_ACCEPTED",actualLevel:1,reachedTargetLevel:false});
  for(const childrenState of ["AVAILABLE","ALL_DISABLED"] as const)
    expect(area.evaluateSelection(dataset,[{...leaf[0]!,childrenState,hasChildren:true}],input(leaf),{policy:{allowEarlyTermination:true}}))
      .toMatchObject({accepted:false,reason:"TARGET_LEVEL_NOT_REACHED"});
  expect(area.evaluateSelection(dataset,path,input(path,3),{policy:{allowEarlyTermination:true}}))
    .toMatchObject({accepted:false,reason:"TARGET_LEVEL_EXCEEDED",actualLevel:5});
});

it("requires an exact source/version/code exception for a level 2 group and target 2", () => {
  const nodes=[path[0]!,{...path[1]!,nodeKind:"group" as const,selectable:false}];
  const rule={source:dataset.source,versionCode:dataset.versionCode,codes:["0101"]};
  for(const exception of [{...rule,source:"other"},{...rule,versionCode:"other"},{...rule,codes:["01"]}])
    expect(area.evaluateSelection(dataset,nodes,input(nodes,2),{policy:{groupEndpointExceptions:[exception]}}))
      .toMatchObject({accepted:false,reason:"NAVIGATION_ONLY",reachedTargetLevel:true});
  const options={policy:{groupEndpointExceptions:[rule],allowEarlyTermination:true}};
  expect(area.evaluateSelection(dataset,nodes,input(nodes,2),options)).toMatchObject({accepted:true,reason:"GROUP_ENDPOINT_EXCEPTION"});
  expect(area.evaluateSelection(dataset,nodes,input(nodes,3),options)).toMatchObject({accepted:false,reason:"NAVIGATION_ONLY"});
  const root=[{...path[0]!,nodeKind:"group" as const,selectable:false}];
  expect(area.evaluateSelection(dataset,root,input(root,1),{policy:{groupEndpointExceptions:[{...rule,codes:["01"]}]}}))
    .toMatchObject({accepted:false,reason:"NAVIGATION_ONLY"});
});

it("rejects a disabled ancestor before considering group exceptions or early termination", () => {
  const nodes=[{...path[0]!,effectiveEnabled:false},{...path[1]!,nodeKind:"group" as const,selectable:false}];
  expect(area.evaluateSelection(dataset,nodes,input(nodes,2),{policy:{allowEarlyTermination:true,
    groupEndpointExceptions:[{source:dataset.source,versionCode:dataset.versionCode,codes:["0101"]}]}}))
    .toMatchObject({accepted:false,reason:"NOT_SELECTABLE"});
});

it("rejects incomplete, reordered and structurally invalid paths without inventing a resolved path", () => {
  for(const candidatePathCodes of [["0101","01","010101"],["01","010101"],["02","0101","010101"],["01","01","010101"]]) {
    expect(area.evaluateSelection(dataset,path.slice(0,3),{pathCodes:candidatePathCodes})).toMatchObject({
      accepted:false,reason:"PARENT_MISMATCH",code:null,level:null,actualLevel:null,pathCodes:null,pathNames:null,candidatePathCodes,
    });
  }
  for(const nodes of [[{...path[0]!,parentCode:"other"}], [{...path[0]!,level:2 as const}],
    [path[0]!,{...path[1]!,parentCode:"other"}], [path[0]!,{...path[1]!,level:3 as const}]])
    expect(area.evaluateSelection(dataset,nodes,input(nodes))).toMatchObject({accepted:false,reason:"PARENT_MISMATCH"});
  expect(area.evaluateSelection(dataset,[],{pathCodes:["missing"]})).toMatchObject({reason:"UNKNOWN_CODE",pathNames:null});
  expect(area.evaluateSelection(dataset,path.slice(0,1),{pathCodes:["01"],versionCode:"other"}))
    .toMatchObject({reason:"VERSION_UNAVAILABLE",pathCodes:null});
});

it("throws on malformed input and never reads policy fields from the input", async () => {
  const invalidInputs=[null,{}, {pathCodes:[]},{pathCodes:Array(6).fill("01")},{pathCodes:[1]},{pathCodes:[""]},
    {pathCodes:["01"],targetLevel:null},{pathCodes:["01"],targetLevel:6},{pathCodes:["01"],targetLevel:1.5},
    {pathCodes:["01"],datasetId:null}];
  for(const value of invalidInputs)
    expect(()=>area.evaluateSelection(dataset,path.slice(0,1),value as ValidationInput)).toThrowError(expect.objectContaining({code:"INVALID_ARGUMENT"}));
  const leaf=[{...path[0]!,hasChildren:false,childrenState:"NONE_IN_SNAPSHOT" as const}];
  expect(area.evaluateSelection(dataset,leaf,{pathCodes:["01"],policy:{allowEarlyTermination:true}} as ValidationInput))
    .toMatchObject({accepted:false,reason:"TARGET_LEVEL_NOT_REACHED"});
  const store:AreaStore={read:async()=>{throw new Error("storage secret");},write:async()=>{throw new Error("unused");}};
  await expect(createAreaKit({store,authorize:async()=>false}).validateSelection(null,{pathCodes:["01"]}))
    .rejects.toMatchObject({code:"FORBIDDEN"});
  await expect(createAreaKit({store,authorize:async()=>true}).validateSelection(null,{pathCodes:["01"]}))
    .rejects.toMatchObject({code:"QUERY_FAILED",message:"区域查询失败"});
});
