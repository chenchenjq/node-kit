import {afterEach,expect,it} from "vitest";
import {createAreaKit} from "../../src/server/index.js";
import {createDrizzleAreaStore} from "../../src/postgres/store.js";
import type {Level,ValidationInput} from "../../src/types.js";
import {createPgHarness} from "./harness.js";

const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0))await cleanup();});
async function setup(seed=true) {
  const h=await createPgHarness();cleanups.push(()=>h.close());
  const store=createDrizzleAreaStore(h.pool,{schemaName:h.schemaName});
  const kit=createAreaKit({store,authorize:async()=>true});
  const datasetId=seed?await h.seedDataset({status:"ready",isActive:true,versionCode:"v1"}):"";
  async function node(code:string,level:Level,parentId:string|null,name=code,kind:"region"|"group"="region",id=datasetId) {
    return h.seedRegion(id,{code,level,parentCode:null,sourceName:name,nodeKind:kind,ancestorCodes:[]},parentId);
  }
  return {h,store,kit,datasetId,node};
}

it("validates canonical paths including groups, rejects wrong ancestry, and preserves same names",async()=>{
  const {kit,store,datasetId,node}=await setup();
  const root=await node("01",1,null,"省"), group=await node("0101",2,root,"同名","group");
  await node("010101",3,group,"同名");await node("02",1,null,"另一省");
  await store.write(view=>view.updatePresentation(datasetId,"0101",1,{displayName:"分组别名"}));
  const valid={pathCodes:["01","0101","010101"],pathNames:["伪造省","伪造市","伪造县"]};
  expect(await kit.validateSelection(null,valid)).toMatchObject({accepted:true,reason:"TARGET_REACHED",
    datasetId,pathCodes:["01","0101","010101"],pathNames:["省","分组别名","同名"]});
  await store.write(view=>view.updatePresentation(datasetId,"0101",2,{displayName:null}));
  expect((await kit.validateSelection(null,valid)).pathNames).toEqual(["省","同名","同名"]);
  for(const pathCodes of [["01","010101"],["02","0101","010101"],["0101","01","010101"],["0101","010101"],["01","01","010101"]])
    expect(await kit.validateSelection(null,{pathCodes})).toMatchObject({accepted:false,reason:"PARENT_MISMATCH",
      datasetId,code:null,level:null,actualLevel:null,pathCodes:null,pathNames:null,candidatePathCodes:pathCodes});
  for(const pathCodes of [["01","0101","missing"],["missing","0101","010101"]])
    expect(await kit.validateSelection(null,{pathCodes})).toMatchObject({accepted:false,reason:"UNKNOWN_CODE",pathCodes:null,pathNames:null});
  expect(await kit.validateSelection(null,{pathCodes:["01","0101"]},{policy:{allowEarlyTermination:true}}))
    .toMatchObject({accepted:false,reason:"NAVIGATION_ONLY"});
  expect(await kit.validateSelection(null,{pathCodes:["01","0101"],targetLevel:2},{policy:{groupEndpointExceptions:[
    {source:"synthetic-test-only",versionCode:"v1",codes:["0101"]},
  ]}})).toMatchObject({accepted:true,reason:"GROUP_ENDPOINT_EXCEPTION"});
});

it("distinguishes snapshot leaves, disabled descendants and disabled ancestors",async()=>{
  const {kit,store,datasetId,node}=await setup();
  const root=await node("01",1,null),city=await node("0101",2,root);await node("010101",3,city);
  const early={policy:{allowEarlyTermination:true}};
  expect(await kit.validateSelection(null,{pathCodes:["01","0101","010101"],targetLevel:5}))
    .toMatchObject({accepted:false,reason:"TARGET_LEVEL_NOT_REACHED"});
  expect(await kit.validateSelection(null,{pathCodes:["01","0101","010101"],targetLevel:5},early))
    .toMatchObject({accepted:true,reason:"EARLY_TERMINATION_ACCEPTED",actualLevel:3,reachedTargetLevel:false});
  await store.write(view=>view.updatePresentation(datasetId,"010101",1,{enabled:false}));
  expect(await kit.validateSelection(null,{pathCodes:["01","0101"]},early))
    .toMatchObject({accepted:false,reason:"TARGET_LEVEL_NOT_REACHED"});
  await store.write(view=>view.updatePresentation(datasetId,"010101",2,{enabled:true}));
  await store.write(view=>view.updatePresentation(datasetId,"01",1,{enabled:false}));
  expect(await kit.validateSelection(null,{pathCodes:["01","0101","010101"]},early))
    .toMatchObject({accepted:false,reason:"NOT_SELECTABLE",pathCodes:["01","0101","010101"]});
});

it("returns unresolved unavailable versions and enforces only the trusted version policy",async()=>{
  const {kit,h,node}=await setup(false);
  expect(await kit.validateSelection(null,{pathCodes:["01"]})).toMatchObject({reason:"NOT_INITIALIZED",datasetId:null,versionCode:null,pathNames:null});
  expect(await kit.validateSelection(null,{versionCode:"missing",pathCodes:["01"]})).toMatchObject({reason:"VERSION_UNAVAILABLE",pathCodes:null});
  const active=await h.seedDataset({status:"ready",isActive:true,versionCode:"a"});
  const old=await h.seedDataset({status:"ready",versionCode:"b"});
  const failed=await h.seedDataset({status:"failed",versionCode:"failed"});
  await node("01",1,null,"旧省","region",old);
  await node("02",1,null,"新省","region",active);
  expect(await kit.validateSelection(null,{datasetId:old,pathCodes:["01"],targetLevel:1})).toMatchObject({accepted:true,versionCode:"b"});
  expect(await kit.validateSelection(null,{datasetId:old,pathCodes:["01"],targetLevel:1,versionPolicy:"specified-ready"} as ValidationInput,{versionPolicy:"active-only"}))
    .toMatchObject({accepted:false,reason:"DATASET_NOT_ACCEPTED"});
  expect(await kit.validateSelection(null,{pathCodes:["02"],targetLevel:1},{versionPolicy:"active-only"})).toMatchObject({accepted:true,versionCode:"a"});
  expect(await kit.validateSelection(null,{datasetId:active,pathCodes:["01"],targetLevel:1})).toMatchObject({reason:"UNKNOWN_CODE",pathNames:null});
  for(const selector of [{datasetId:failed},{datasetId:old,versionCode:"a"},{datasetId:"missing"}])
    expect(await kit.validateSelection(null,{...selector,pathCodes:["01"]})).toMatchObject({reason:"VERSION_UNAVAILABLE",pathNames:null});
});

it("throws malformed-input, scoped-authorization and database errors instead of business rejections",async()=>{
  const {kit,store,h,node}=await setup();await node("01",1,null);
  for(const value of [null,{pathCodes:[]},{pathCodes:Array(6).fill("01")},{pathCodes:[1]},{pathCodes:["01"],targetLevel:null}])
    await expect(kit.validateSelection(null,value as ValidationInput)).rejects.toMatchObject({code:"INVALID_ARGUMENT"});
  const denied=createAreaKit({store,authorize:async(_ctx,request)=>request.datasetId===undefined});
  await expect(denied.validateSelection(null,{pathCodes:["01"],targetLevel:1})).rejects.toMatchObject({code:"FORBIDDEN"});
  await h.pool.query(`DROP TABLE "${h.schemaName}".area_region CASCADE`);
  await expect(kit.validateSelection(null,{pathCodes:["01"],targetLevel:1})).rejects.toMatchObject({code:"QUERY_FAILED",message:"区域查询失败"});
});

it("uses one snapshot for active version policy, canonical paths and presentation",async()=>{
  const {h,store,datasetId,node}=await setup();await node("01",1,null,"旧省");
  let changed=false;
  const kit=createAreaKit({store,authorize:async(_ctx,request)=>{
    if(request.datasetId&&!changed) {
      changed=true;
      await h.pool.query(`UPDATE "${h.schemaName}".area_region SET display_name='新省',enabled=false WHERE dataset_id=$1`,[datasetId]);
      await h.pool.query(`UPDATE "${h.schemaName}".area_dataset SET is_active=false WHERE id=$1`,[datasetId]);
    }
    return true;
  }});
  expect(await kit.validateSelection(null,{datasetId,pathCodes:["01"],targetLevel:1},{versionPolicy:"active-only"}))
    .toMatchObject({accepted:true,reason:"TARGET_REACHED",pathNames:["旧省"]});
  expect(await kit.validateSelection(null,{datasetId,pathCodes:["01"],targetLevel:1},{versionPolicy:"active-only"}))
    .toMatchObject({accepted:false,reason:"DATASET_NOT_ACCEPTED"});
});
