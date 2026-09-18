import {afterEach,expect,it} from "vitest";
import * as server from "../../src/server/index.js";
import {createDrizzleAreaStore} from "../../src/postgres/store.js";
import {createPgHarness} from "./harness.js";
const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0))await cleanup();});
async function setup(seed=true){
  const h=await createPgHarness();cleanups.push(()=>h.close());
  const store=createDrizzleAreaStore(h.pool,{schemaName:h.schemaName});
  expect(server).toHaveProperty("createAreaKit");
  const kit=server.createAreaKit({store,authorize:async()=>true});
  const datasetId=seed?await h.seedDataset({status:"ready",isActive:true,versionCode:"v1"}):"";
  async function node(code:string,level:1|2|3|4|5,parentId:string|null,name=code,kind:"region"|"group"="region"){
    return h.seedRegion(datasetId,{code,level,parentCode:null,sourceName:name,nodeKind:kind,ancestorCodes:[]},parentId);
  }
  return {h,store,kit,datasetId,node};
}
it("resolves ready versions and distinguishes absent, unavailable and unknown codes",async()=>{
  const {h,kit}=await setup(false);
  await expect(kit.listProvinces(null)).rejects.toMatchObject({code:"NOT_INITIALIZED"});
  await expect(kit.getDataset(null,{versionCode:"missing"})).rejects.toMatchObject({code:"VERSION_UNAVAILABLE"});
  await expect(kit.getDataset(null,{datasetId:"missing"})).rejects.toMatchObject({code:"VERSION_UNAVAILABLE"});
  const a=await h.seedDataset({status:"ready",isActive:true,versionCode:"a"});
  const b=await h.seedDataset({status:"ready",versionCode:"b"});
  const c=await h.seedDataset({status:"failed",versionCode:"c"});
  expect((await kit.getDataset(null)).datasetId).toBe(a);
  expect((await kit.getDataset(null,{datasetId:b})).datasetId).toBe(b);
  await expect(kit.getDataset(null,{datasetId:a,versionCode:"b"})).rejects.toMatchObject({code:"VERSION_UNAVAILABLE"});
  await expect(kit.getDataset(null,{datasetId:c})).rejects.toMatchObject({code:"VERSION_UNAVAILABLE"});
  for(const action of [()=>kit.getRegion(null,{code:"missing"}),()=>kit.getPath(null,{code:"missing"}),
    ()=>kit.listChildren(null,{parentCode:"missing"}),()=>kit.listRegions(null,{ancestorCode:"missing"}),()=>kit.getTree(null,{ancestorCode:"missing"})]){
    await expect(action()).rejects.toMatchObject({code:"UNKNOWN_CODE"});
  }
  expect((await kit.listDatasets(null)).items).toHaveLength(2);
  expect((await kit.listDatasets(null,{includeUnavailable:true})).items).toHaveLength(3);
});
it("returns full paths, string codes, aliases and disabled ancestor state",async()=>{
  const {h,kit,store,datasetId,node}=await setup();
  const p=await node("01",1,null,"省一"),q=await node("02",1,null,"省二");
  const c=await node("0101",2,p,"同名市"),d=await node("0201",2,q,"同名市","group");
  await node("010101",3,c,"区");await node("020101",3,d,"区");
  await store.write(view=>view.updatePresentation(datasetId,"0101",1,{displayName:"别名%_\\"}));
  const hits=await kit.search(null,{keyword:"同名"});
  expect(hits.items.map(n=>n.pathCodes)).toEqual([["01","0101"],["02","0201"]]);
  expect(hits.items[0]?.pathNames).toEqual(["省一","别名%_\\"]);
  expect(hits.items[1]).toMatchObject({navigable:true,selectable:false,hasChildren:true});
  expect((await kit.search(null,{keyword:"%_\\"})).items.map(n=>n.code)).toEqual(["0101"]);
  expect((await kit.search(null,{keyword:"010"})).items.map(n=>n.code)).toEqual(["0101","010101"]);
  expect((await kit.getRegions(null,{codes:["0101","missing","01","0101"]}))).toMatchObject({items:[{code:"0101"},{code:"01"}],missingCodes:["missing"]});
  await store.write(view=>view.updatePresentation(datasetId,"01",1,{enabled:false}));
  const children=await kit.listChildren(null,{parentCode:"0101"});
  expect(children.items[0]).toMatchObject({enabled:true,effectiveEnabled:false,navigable:false,selectable:false});
  expect((await kit.listChildren(null,{parentCode:"0101",selectableOnly:true})).items).toEqual([]);
  expect((await kit.getRegion(null,{code:"0101"}))).toMatchObject({childrenState:"ALL_DISABLED",hasChildren:true});
  const path=await kit.getPath(null,{code:"010101"});
  expect(path.pathCodes).toEqual(["01","0101","010101"]);expect(path.nodes.every(n=>!n.effectiveEnabled)).toBe(true);
  expect(await kit.getDataset(null)).not.toHaveProperty("report");
  expect(h.schemaName).toBeTruthy();
});
it("paginates deterministically and binds cursors to library, version and normalized filters",async()=>{
  const {kit,node,h}=await setup(); await node("01",1,null);await node("02",1,null);await node("03",1,null);
  const first=await kit.listProvinces(null,{limit:2});expect(first.items.map(n=>n.code)).toEqual(["01","02"]);expect(first.hasMore).toBe(true);
  const last=await kit.listProvinces(null,{limit:2,cursor:first.nextCursor!});expect(last.items.map(n=>n.code)).toEqual(["03"]);expect(last.nextCursor).toBeNull();
  const other=await setup();
  await other.h.pool.query(`UPDATE "${other.h.schemaName}".area_dataset SET id=$1 WHERE id=$2`,[first.datasetId,other.datasetId]);
  await expect(other.kit.listProvinces(null,{cursor:first.nextCursor!})).rejects.toMatchObject({code:"INVALID_ARGUMENT"});
  const b=await h.seedDataset({status:"ready",versionCode:"v2"});
  await expect(kit.listProvinces(null,{datasetId:b,cursor:first.nextCursor!})).rejects.toMatchObject({code:"INVALID_ARGUMENT"});
  await expect(kit.listRegions(null,{level:2,cursor:first.nextCursor!})).rejects.toMatchObject({code:"INVALID_ARGUMENT"});
  const cursor=first.nextCursor!;
  for(const bad of ["bad",cursor+"=",Buffer.from(JSON.stringify({...JSON.parse(Buffer.from(cursor,"base64url").toString()),extra:true})).toString("base64url")])
    await expect(kit.listProvinces(null,{cursor:bad})).rejects.toMatchObject({code:"INVALID_ARGUMENT"});
});
it("rejects invalid input and impossible parent/ancestor levels",async()=>{
  const {kit,node}=await setup();const p=await node("01",1,null),c=await node("0101",2,p);await node("010101",3,c);
  for(const limit of [0,201,1.5,NaN])await expect(kit.listProvinces(null,{limit})).rejects.toMatchObject({code:"INVALID_ARGUMENT"});
  await expect(kit.getRegions(null,{codes:Array(201).fill("01")})).rejects.toMatchObject({code:"INVALID_ARGUMENT"});
  await expect(kit.search(null,{keyword:"x".repeat(101)})).rejects.toMatchObject({code:"INVALID_ARGUMENT"});
  await expect(kit.search(null,{keyword:"  "})).rejects.toMatchObject({code:"INVALID_ARGUMENT"});
  await expect(kit.listRegions(null,{ancestorCode:"0101",level:1})).rejects.toMatchObject({code:"INVALID_ARGUMENT"});
  await expect(kit.listChildren(null,{parentCode:"01",level:3})).rejects.toMatchObject({code:"INVALID_ARGUMENT"});
  await expect(kit.getRegion(null,{code:1 as unknown as string})).rejects.toMatchObject({code:"INVALID_ARGUMENT"});
});
it("builds bounded small trees and preserves final-level child facts",async()=>{
  const {kit,node}=await setup();const p=await node("01",1,null),c=await node("0101",2,p),d=await node("010101",3,c);await node("010101001",4,d);
  const tree=await kit.getTree(null);expect(tree.items[0]?.children[0]?.children[0]).toMatchObject({code:"010101",hasChildren:true,children:[]});
  expect((await kit.getTree(null,{ancestorCode:"0101"})).items[0]?.children).toHaveLength(1);
  expect((await kit.getTree(null,{depth:1})).items[0]).toMatchObject({code:"01",hasChildren:true,children:[]});
  for(const input of [{depth:null as unknown as number},{maxNodes:null as unknown as number},{depth:0},{depth:4},{depth:1.5},{maxNodes:0},{maxNodes:5001},{ancestorCode:"0101",depth:3},{ancestorCode:"010101001"}])
    await expect(kit.getTree(null,input)).rejects.toMatchObject({code:"INVALID_ARGUMENT"});
  await expect(kit.getTree(null,{maxNodes:2})).rejects.toMatchObject({code:"QUERY_LIMIT_EXCEEDED"});
});
it("allows exactly 5000 tree nodes and fails at 5001 without truncating",async()=>{
  const {h,kit,datasetId}=await setup();
  await h.pool.query(`INSERT INTO "${h.schemaName}".area_region (id,dataset_id,code,source_name,level,node_kind)
    SELECT gen_random_uuid(),$1,LPAD(i::text,6,'0'),'省',1,'region' FROM generate_series(1,5000) i`,[datasetId]);
  expect((await kit.getTree(null)).items).toHaveLength(5000);
  await h.seedRegion(datasetId,{code:"extra",sourceName:"省",level:1,parentCode:null,nodeKind:"region",ancestorCodes:[]});
  await expect(kit.getTree(null)).rejects.toMatchObject({code:"QUERY_LIMIT_EXCEEDED"});
});
it("keeps dataset resolution, page rows and presentation summaries in one snapshot",async()=>{
  const {h,store,datasetId,node}=await setup();await node("01",1,null,"旧名称");
  let changed=false;
  const kit=server.createAreaKit({store,authorize:async(_ctx,request)=>{
    if(request.datasetId && !changed){
      changed=true;
      await h.pool.query(`UPDATE "${h.schemaName}".area_region SET display_name='新名称',enabled=false WHERE dataset_id=$1`,[datasetId]);
      const other=await h.seedDataset({status:"ready",versionCode:"v2"});
      await h.pool.query(`UPDATE "${h.schemaName}".area_dataset SET is_active=false WHERE id=$1`,[datasetId]);
      await h.pool.query(`UPDATE "${h.schemaName}".area_dataset SET is_active=true WHERE id=$1`,[other]);
    }
    return true;
  }});
  const result=await kit.listProvinces(null);
  expect(result).toMatchObject({datasetId,versionCode:"v1",items:[{label:"旧名称",enabled:true,effectiveEnabled:true}]});
  expect((await kit.getDataset(null)).versionCode).toBe("v2");
});
