import {expect, it} from "vitest";
import {initialSelectionState, selectionReducer} from "../src/react/selection-state.js";
import {syntheticRegion} from "./fixtures/factory.js";

it("ignores a page from a generation invalidated by disabled props", () => {
  const initial=initialSelectionState({disabled:false,targetLevel:3,policyKey:"strict"});
  const loading=selectionReducer(initial,{type:"start",generation:0,layerIndex:0,requestId:1});
  const disabled=selectionReducer(loading,{type:"props",disabled:true,targetLevel:3,policyKey:"strict",valueKey:""});
  const result=selectionReducer(disabled,{type:"loaded",generation:0,layerIndex:0,requestId:1,parentCode:null,
    page:{datasetId:"00000000-0000-4000-8000-000000000001",versionCode:"synthetic:v1",items:[syntheticRegion()],hasMore:false,nextCursor:null}});
  expect(result).toBe(disabled);
});

it("clears descendants and creates a fresh child layer when a parent is chosen", () => {
  const province=syntheticRegion({code:"01",level:1,hasChildren:true});
  const city=syntheticRegion({code:"0101",level:2,parentCode:"01",hasChildren:true});
  const state=selectionReducer(
    selectionReducer(
      selectionReducer(initialSelectionState({disabled:false,targetLevel:3,policyKey:"strict"}),{type:"choose",node:province}),
      {type:"choose",node:city}),
    {type:"choose",node:province},
  );
  expect(state.path).toEqual([province]);
  expect(state.layers).toHaveLength(2);
  expect(state.layers[1]).toMatchObject({parentCode:"01",phase:"unloaded",items:[]});
  expect(state.status).toBeNull();
});

it("retains loaded ancestor options while discarding only descendant layers", () => {
  const province=syntheticRegion({code:"01",level:1,hasChildren:true});
  const root=selectionReducer(
    selectionReducer(initialSelectionState({disabled:false,targetLevel:3,policyKey:"strict"}),{type:"start",generation:0,layerIndex:0,requestId:1}),
    {type:"loaded",generation:0,layerIndex:0,requestId:1,parentCode:null,
      page:{datasetId:"dataset",versionCode:"v1",items:[province],hasMore:false,nextCursor:null}},
  );
  const chosen=selectionReducer(root,{type:"choose",node:province});
  expect(chosen.layers[0]?.items).toEqual([province]);
  expect(chosen.layers[1]).toMatchObject({parentCode:"01",phase:"unloaded",items:[]});
});

it("deduplicates pagination by code only for the current layer request", () => {
  const first=syntheticRegion({code:"01"});
  const replacement=syntheticRegion({code:"01",label:"更新名称"});
  const second=syntheticRegion({code:"02",label:"第二省"});
  const loading=selectionReducer(initialSelectionState({disabled:false,targetLevel:3,policyKey:"strict"}),
    {type:"start",generation:0,layerIndex:0,requestId:7});
  const firstPage=selectionReducer(loading,{type:"loaded",generation:0,layerIndex:0,requestId:7,parentCode:null,
    page:{datasetId:"dataset",versionCode:"v1",items:[first],hasMore:true,nextCursor:"next"}});
  const nextLoading=selectionReducer(firstPage,{type:"start",generation:0,layerIndex:0,requestId:8});
  const paged=selectionReducer(nextLoading,{type:"loaded",generation:0,layerIndex:0,requestId:8,parentCode:null,
    page:{datasetId:"dataset",versionCode:"v1",items:[replacement,second],hasMore:false,nextCursor:null}});
  expect(paged.layers[0]?.items).toEqual([replacement,second]);
  expect(paged.layers[0]).toMatchObject({hasMore:false,nextCursor:null,phase:"loaded"});
});

it("clears a hydrated path when a controlled value becomes null", () => {
  const province=syntheticRegion({code:"01",level:1});
  const initial=initialSelectionState({disabled:false,targetLevel:3,policyKey:"strict",valueKey:"value"});
  const hydrated=selectionReducer(initial,{type:"hydrate",generation:0,path:[province]});
  const cleared=selectionReducer(hydrated,{type:"props",disabled:false,targetLevel:3,policyKey:"strict",valueKey:""});
  expect(cleared.path).toEqual([]);
  expect(cleared.layers).toHaveLength(1);
  expect(cleared.layers[0]).toMatchObject({parentCode:null,phase:"unloaded"});
});
