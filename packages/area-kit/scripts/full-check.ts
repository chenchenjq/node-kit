import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { cpus, totalmem, platform, release } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { parse } from 'csv-parse';
import pg from 'pg';
import { SOURCE_MANIFEST, type SourceFile } from '../src/source/manifest.js';
import { areaMigrationSql } from '../src/postgres/migration.js';
import { createDrizzleAreaStore } from '../src/postgres/store.js';
import { createAreaKit } from '../src/server/query.js';
import type { DatasetSummary, ImportReport, Level } from '../src/types.js';

const levels = [1, 2, 3, 4, 5] as const;
const expected: Record<Level, number> = {1:31, 2:342, 3:2978, 4:41352, 5:620573};
const groupCodes = ['1101','1201','3101','5001','5002','4190','4290','4690','6590'];
const packageDirectory = fileURLToPath(new URL('../', import.meta.url));
const image = 'postgres@sha256:54451ecb8ab38c24c3ec123f2fd501303a3a1856a5c66e98cecf2460d5e1e9d7';
type Raw = Record<string, string>;
type Sample = {code:string;level:Level;sourceName:string;pathCodes:string[]};
export interface ActualSamples {
  sourceCommit:string; files:SourceFile[];
  ordinary:{pathCodes:string[];pathNames:string[]};
  groups:Sample[]; sameNamePairs:{codes:string[];sourceName:string}[];
  unknownSpecial:{code:string;pathCodes:string[];sourceName:string}[];
  sourceNodes:{code:string;sourceName:string;level:Level;pathCodes:string[]}[];
}

/** Independent oracle: CSV columns supply every path and name, never getPath/classifyNode. */
export async function extractActualSamples(sourceDirectory:string):Promise<ActualSamples> {
  const rows = new Map<string, Raw>();
  const groups:Sample[] = [], unknownSpecial:Sample[] = [];
  const countyNames = new Map<string, string[]>();
  let ordinary:ActualSamples['ordinary'] | undefined;
  for (const file of SOURCE_MANIFEST.files) {
    const hash = createHash('sha256'); let bytes = 0;
    for await (const chunk of createReadStream(join(sourceDirectory,file.path))) { hash.update(chunk); bytes += (chunk as Buffer).length; }
    assert.equal(hash.digest('hex'), file.sha256, `${file.path} raw checksum`);
    assert.equal(bytes, file.bytes);
    let count = 0;
    const parser = createReadStream(join(sourceDirectory,file.path)).pipe(parse({columns:true,bom:true}));
    for await (const raw of parser as AsyncIterable<Raw>) {
      count++;
      const pathCodes = ['provinceCode','cityCode','areaCode','streetCode'].slice(0,file.level-1).map(key=>raw[key]!);
      pathCodes.push(raw.code!);
      if (file.level < 5) rows.set(raw.code!,raw);
      if (file.level === 2 && groupCodes.includes(raw.code!)) groups.push({code:raw.code!,level:2,sourceName:raw.name!,pathCodes});
      if (file.level === 3) countyNames.set(raw.name!, [...(countyNames.get(raw.name!) ?? []),raw.code!]);
      if (file.level >= 3 && unknownSpecial.length < 6 && /开发区|工业园|管理区|农场/.test(raw.name!))
        unknownSpecial.push({code:raw.code!,level:file.level,sourceName:raw.name!,pathCodes});
      if (file.level === 5 && !ordinary && !groupCodes.includes(raw.cityCode!))
        ordinary = {pathCodes,pathNames:pathCodes.map(code=>code===raw.code?raw.name!:rows.get(code)!.name!)};
    }
    assert.equal(count,expected[file.level],`${file.path} independent raw row count`);
    console.error(`[full] verified raw level ${file.level}: ${count} rows, ${bytes} bytes`);
  }
  assert(ordinary); assert.equal(groups.length,9); assert(unknownSpecial.length > 0);
  const sameNamePairs:ActualSamples['sameNamePairs'] = [];
  for (const sourceName of ['东莞市','中山市','儋州市']) {
    const codes = [...rows.values()].filter(row=>row.name===sourceName && [4,6].includes(row.code!.length)).map(row=>row.code!);
    assert.equal(codes.length,2); sameNamePairs.push({codes,sourceName});
  }
  const duplicate = [...countyNames].find(([,codes])=>codes.length>1)!;
  sameNamePairs.push({sourceName:duplicate[0],codes:duplicate[1]});
  const selected = new Set([...ordinary.pathCodes, ...groups.flatMap(row=>row.pathCodes), ...unknownSpecial.flatMap(row=>row.pathCodes)]);
  for (const pair of sameNamePairs) for (const code of pair.codes) {
    const row=rows.get(code)!;selected.add(code);for(const field of ['provinceCode','cityCode'])if(row[field])selected.add(row[field]!);
  }
  const sourceNodes = [...selected].map(code=>{
    if(code===ordinary!.pathCodes[4])return {code,sourceName:ordinary!.pathNames[4]!,level:5 as const,pathCodes:ordinary!.pathCodes};
    const row=rows.get(code)!,level=([2,4,6,9].indexOf(code.length)+1) as Level;
    return {code,sourceName:row.name!,level,pathCodes:[...['provinceCode','cityCode','areaCode','streetCode'].slice(0,level-1).map(field=>row[field]!),code]};
  });
  return {sourceCommit:SOURCE_MANIFEST.sourceCommit,files:SOURCE_MANIFEST.files,ordinary,groups,sameNamePairs,unknownSpecial,sourceNodes};
}

export function percentile(values:readonly number[],p:number):number {
  if(values.length===0) throw new Error('Empty performance sample');
  const sorted=[...values].sort((a,b)=>a-b);
  return sorted[Math.min(sorted.length-1,Math.max(0,Math.ceil(sorted.length*p)-1))]!;
}
async function json(path:string,value:unknown) { await writeFile(path,JSON.stringify(value,null,2)+'\n'); }
async function optionalText(path:string) { return readFile(path,'utf8').then(s=>s.trim()).catch(()=>null); }

export async function runFullVerification(input:{sourceDirectory:string;reportDirectory:string;connection:{host:string;port:number;user:string;password:string;database:string}}):Promise<void> {
  assert.equal(input.connection.database,'area_kit_ephemeral_test','Only ephemeral test database is permitted');
  const sourceDirectory=resolve(input.sourceDirectory),reportDirectory=resolve(input.reportDirectory);
  assert(sourceDirectory!==reportDirectory && reportDirectory!==resolve(packageDirectory) && !reportDirectory.startsWith(packageDirectory),'Reports must be outside the package and source directory');
  await stat(join(sourceDirectory,'prepared-source.json'));
  await mkdir(reportDirectory,{recursive:true});
  const started=performance.now(),timings:Record<string,number>={};
  const cliProcesses:Record<string,unknown>={};
  const evidence:Record<string,unknown>={passed:false,synthetic:false,startedAt:new Date().toISOString(),sourceCommit:SOURCE_MANIFEST.sourceCommit,timings,cliProcesses,measurementNotes:['Query counts include BEGIN, transaction setup and COMMIT.','firstMs measures the first request of each benchmark after functional verification; it is not a cold-cache claim.']};
  const pool = new pg.Pool({...input.connection,ssl:false,max:4,connectionTimeoutMillis:5000});
  type Statement={text:string;values:unknown[]};
  let capture:Statement[]|null=null;
  pool.on('connect',client=>{
    const query=client.query;
    client.query=function(...args:unknown[]) {
      if(capture) {
        const config=args[0] as {text?:string;values?:unknown[]} | string;
        capture.push({text:typeof config==='string'?config:config.text??'',values:typeof config==='string'?(Array.isArray(args[1])?args[1]:[]):config.values??(Array.isArray(args[1])?args[1]:[])});
      }
      return Reflect.apply(query,client,args);
    } as typeof client.query;
  });
  const kit=createAreaKit({store:createDrizzleAreaStore(pool),authorize:async()=>true});
  async function cli(args:string[],label:string):Promise<DatasetSummary> {
    const url=new URL('postgresql://localhost');
    url.hostname=input.connection.host;url.port=String(input.connection.port);url.username=input.connection.user;
    url.password=input.connection.password;url.pathname='/'+input.connection.database;
    const environment=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.toUpperCase().startsWith('PG') && !['DATABASE_URL','AREA_KIT_DATABASE_URL','AREA_KIT_TEST_POSTGRES'].includes(key.toUpperCase())));
    const start=performance.now();
    const output=await new Promise<string>((resolveOutput,reject)=>{
      const child=spawn(process.execPath,[join(packageDirectory,'dist/cli.js'),...args],{
        cwd:packageDirectory,env:{...environment,AREA_KIT_DATABASE_URL:url.href},stdio:['ignore','pipe','pipe'],
      });
      let stdout='',stderr='';
      child.stdout.on('data',chunk=>{stdout+=String(chunk);});
      child.stderr.on('data',chunk=>{stderr+=String(chunk);process.stderr.write(chunk);});
      child.once('error',reject);
      child.once('close',code=>{
        void writeFile(join(reportDirectory,`${label}.log`),stderr+'\n'+stdout);
        cliProcesses[label]={peakRssKiB:Number(stderr.match(/peakRssKiB=(\d+)/)?.[1]??0)||null,sourceAuditMs:Number(stderr.match(/source audit elapsedMs=(\d+)/)?.[1]??0)||null};
        if(code!==0)reject(new Error(`${label} failed with exit ${code}; see its log`));else resolveOutput(stdout);
      });
    });
    timings[label]=performance.now()-start;
    return JSON.parse(output.trim().split('\n').at(-1)!) as DatasetSummary;
  }
  try {
    evidence.environment={cpu:cpus()[0]?.model,cpuCount:cpus().length,ramBytes:totalmem(),os:platform(),release:release(),
      node:process.version,drizzle:JSON.parse(await readFile(join(packageDirectory,'node_modules/drizzle-orm/package.json'),'utf8')).version,
      postgres:(await pool.query('SELECT version() AS version')).rows[0].version,containerImage:image,
      memoryLimit:await optionalText('/sys/fs/cgroup/memory.max'),cpuLimit:await optionalText('/sys/fs/cgroup/cpu.max'),batchSize:1000};
    evidence.preparation=JSON.parse(await readFile(join(sourceDirectory,'prepared-source.json'),'utf8'));
    evidence.preparationMeasurement=await readFile(join(sourceDirectory,'preparation-measurement.json'),'utf8').then(JSON.parse).catch(()=>({measured:false,note:'Preparation occurred before this verification run'}));
    await pool.query(areaMigrationSql());
    await assert.rejects(kit.getDataset(null),{code:'NOT_INITIALIZED'});
    assert.equal((await kit.validateSelection(null,{pathCodes:['11']})).reason,'NOT_INITIALIZED');
    const verificationStart=performance.now();
    const samples=await extractActualSamples(sourceDirectory);
    timings.rawVerificationAndSampleExtraction=performance.now()-verificationStart;
    await json(join(reportDirectory,'source-samples.json'),{...samples,selectionBasis:'Paths and names copied from raw CSV columns; nine exact source city groups, first ordinary village outside those groups, repeated city/county names and repeated county names, first six special-looking names (classification remains unknown).',excluded:SOURCE_MANIFEST.coverage.excluded});
    const importDirectory=join(reportDirectory,'first-import');
    const dataset=await cli(['import','--dir',sourceDirectory,'--report-dir',importDirectory],'import');
    assert.equal(dataset.status,'ready');assert.equal(dataset.isActive,false);
    await assert.rejects(kit.getDataset(null),{code:'NOT_INITIALIZED'});
    assert.equal((await kit.getDataset(null,{datasetId:dataset.datasetId})).datasetId,dataset.datasetId);
    const admin=await kit.getDatasetReport(null,{datasetId:dataset.datasetId});
    const report=JSON.parse(await readFile(join(importDirectory,'import-report.json'),'utf8')) as ImportReport;
    assert.deepEqual(admin.report,report);assert.equal(report.passed,true);
    for(const level of levels) {
      assert.equal(dataset.levelCounts[level],expected[level]);
      assert.equal(report.counts[level].valid,expected[level]);
      for(const key of ['conflict','missingParent','ancestorMismatch','invalid','duplicate'] as const) assert.equal(report.counts[level][key],0);
      assert.equal(report.databaseDigests[level],report.sourceDigests[level]);
    }
    assert.equal(Object.values(expected).reduce((a,b)=>a+b,0),665276);
    const independent=await pool.query(`SELECT r.level,count(*)::integer AS count,
      count(*) FILTER(WHERE r.level>1 AND p.id IS NULL)::integer AS missing_parent,
      count(*) FILTER(WHERE p.id IS NOT NULL AND p.dataset_id<>r.dataset_id)::integer AS cross_version,
      count(*) FILTER(WHERE p.id IS NOT NULL AND p.level<>r.level-1)::integer AS wrong_level
      FROM area_region r LEFT JOIN area_region p ON p.id=r.parent_id WHERE r.dataset_id=$1 GROUP BY r.level ORDER BY r.level`,[dataset.datasetId]);
    for(const row of independent.rows) {assert.equal(row.count,expected[row.level as Level]);assert.equal(row.missing_parent+row.cross_version+row.wrong_level,0);}
    assert.equal(independent.rows.length,5);
    await json(join(reportDirectory,'source-audit.json'),{files:samples.files,report,independentSql:independent.rows});
    evidence.dataset=dataset;evidence.report=report;evidence.independentSql=independent.rows;
    evidence.bytes={raw:samples.files.reduce((total,file)=>total+file.bytes,0),normalized:(await Promise.all(levels.map(level=>stat(join(importDirectory,`normalized-${level}.jsonl`))))).reduce((total,file)=>total+file.size,0)};
    const activated=await cli(['activate','--dataset-id',dataset.datasetId],'activate');assert.equal(activated.isActive,true);
    assert.equal((await kit.getDataset(null)).datasetId,dataset.datasetId);
    // Inject only an unavailable dataset state; all imported region data remains the actual source.
    const failed=await pool.query(`INSERT INTO area_dataset (version_code,source,source_commit,rules_version,code_scheme,data_as_of,source_published_at,file_checksums,coverage,status)
      SELECT version_code||':failure-injection',source,source_commit,rules_version,code_scheme,data_as_of,source_published_at,file_checksums,coverage,'failed' FROM area_dataset WHERE id=$1 RETURNING id`,[dataset.datasetId]);
    await assert.rejects(cli(['activate','--dataset-id',failed.rows[0].id],'failed-activation'));
    assert.equal((await kit.getDataset(null)).datasetId,dataset.datasetId);
    await pool.query('DELETE FROM area_dataset WHERE id=$1',[failed.rows[0].id]);
    const codes=samples.ordinary.pathCodes;
    const ordinary=await kit.getPath(null,{code:codes[4]!});
    assert.deepEqual(ordinary.pathCodes,codes);assert.deepEqual(ordinary.pathNames,samples.ordinary.pathNames);
    for(const level of levels) {
      const node=await kit.getRegion(null,{code:codes[level-1]!});assert.equal(node.level,level);
      const list=level===1?await kit.listProvinces(null,{limit:200}):await kit.listChildren(null,{parentCode:codes[level-2]!,limit:200});
      assert(list.items.some(item=>item.code===node.code));
      const search=await kit.search(null,{keyword:node.code,level,limit:200});assert(search.items.some(item=>item.code===node.code));
    }
    const submission=await kit.validateSelection(null,{pathCodes:codes,targetLevel:5});assert.equal(submission.accepted,true);assert.deepEqual(submission.pathNames,samples.ordinary.pathNames);
    assert.equal((await kit.validateSelection(null,{pathCodes:[codes[0]!,codes[2]!],targetLevel:3})).reason,'PARENT_MISMATCH');
    for(const group of samples.groups) {
      const path=await kit.getPath(null,{code:group.code});assert.deepEqual(path.pathCodes,group.pathCodes);
      assert.equal(path.nodes.at(-1)!.nodeKind,'group');assert.equal(path.nodes.at(-1)!.sourceName,group.sourceName);
      assert.equal((await kit.validateSelection(null,{pathCodes:group.pathCodes,targetLevel:2})).reason,'NAVIGATION_ONLY');
    }
    for(const sample of samples.unknownSpecial) {const path=await kit.getPath(null,{code:sample.code});assert.deepEqual(path.pathCodes,sample.pathCodes);assert.equal(path.nodes.at(-1)!.nodeKind,'unknown');}
    for(const pair of samples.sameNamePairs) {
      const result=await kit.getRegions(null,{codes:pair.codes});assert.equal(result.items.length,pair.codes.length);
      assert(result.items.every(node=>node.sourceName===pair.sourceName));
      const found=await kit.search(null,{keyword:pair.sourceName,limit:200});assert(pair.codes.every(code=>found.items.some(node=>node.code===code)));
      for(const code of pair.codes.filter(code=>code.length===6)) if(pair.codes.some(city=>city.length===4)) {
        const path=await kit.getPath(null,{code});assert.deepEqual(path.pathCodes.slice(-2),pair.codes);assert.deepEqual(path.pathNames.slice(-2),[pair.sourceName,pair.sourceName]);
      }
    }
    assert.deepEqual(activated.coverage.excluded,['HK','MO','TW']);
    for(const code of ['71','81','82']) await assert.rejects(kit.getRegion(null,{code}),{code:'UNKNOWN_CODE'});
    // Compare every stable id and local presentation field before and after the real repeated CLI import.
    const settingsCode=samples.unknownSpecial[0]!.code;
    await kit.updatePresentation(null,{code:settingsCode,revision:1,patch:{displayName:'全量验证本地名称',sort:7,enabled:false}});
    const fingerprint=async()=> (await pool.query(`SELECT md5(string_agg(jsonb_build_array(id,code,display_name,sort,enabled,revision)::text,E'\\n' ORDER BY code COLLATE "C")) AS value FROM area_region WHERE dataset_id=$1`,[dataset.datasetId])).rows[0].value;
    const before=await fingerprint();
    const repeated=await cli(['import','--dir',sourceDirectory,'--report-dir',join(reportDirectory,'repeat-import')],'repeat-import');
    assert.equal(repeated.datasetId,dataset.datasetId);assert.equal(repeated.isActive,true);assert.equal(await fingerprint(),before);
    evidence.repeat={datasetId:repeated.datasetId,allIdsAndSettingsFingerprint:before,unchanged:true};
    await kit.updatePresentation(null,{code:settingsCode,revision:2,patch:{displayName:null,sort:0,enabled:true}});
    await pool.query('ANALYZE area_region');await pool.query('ANALYZE area_dataset');
    const performanceReport:Record<string,unknown>={};evidence.performance=performanceReport;
    async function benchmark(name:string,run:()=>Promise<unknown>) {
      console.error(`[full] performance ${name}`);
      capture=[];const firstStart=performance.now();await run();const firstMs=performance.now()-firstStart;
      const statements=capture;capture=null;
      for(let i=0;i<3;i++)await run();
      const durations:number[]=[],queryCounts:number[]=[];
      for(let i=0;i<30;i++){capture=[];const start=performance.now();await run();durations.push(performance.now()-start);queryCounts.push(capture.length);capture=null;}
      const plans=[];
      for(const statement of statements) if(/^\s*(select|with)\b/i.test(statement.text)) {
        const result=await pool.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+statement.text,statement.values);
        plans.push({sql:statement.text,parameters:statement.values,plan:result.rows[0]['QUERY PLAN']});
      }
      performanceReport[name]={firstMs,warmups:3,requests:30,p50:percentile(durations,.5),p95:percentile(durations,.95),durationsMs:durations,dbQueryCounts:queryCounts,firstDbQueries:statements.length,explain:plans};
      await json(join(reportDirectory,'full-verification.json'),evidence);
    }
    await benchmark('single-code',()=>kit.getRegion(null,{code:codes[4]!}));
    await benchmark('batch-code',()=>kit.getRegions(null,{codes}));
    await benchmark('five-level-path',()=>kit.getPath(null,{code:codes[4]!}));
    for(const [label,parentCode] of [['township',codes[2]!],['village',codes[3]!]]) {
      let page=await kit.listChildren(null,{parentCode:parentCode!,limit:5}),lastCursor:string|undefined;
      while(page.nextCursor){lastCursor=page.nextCursor;page=await kit.listChildren(null,{parentCode:parentCode!,limit:5,cursor:lastCursor});}
      assert(lastCursor,`${label} must exercise a real tail cursor`);
      await benchmark(`${label}-children-first`,()=>kit.listChildren(null,{parentCode:parentCode!,limit:5}));
      await benchmark(`${label}-children-tail`,()=>kit.listChildren(null,{parentCode:parentCode!,limit:5,cursor:lastCursor!}));
    }
    await benchmark('ancestor-range',()=>kit.listRegions(null,{ancestorCode:codes[2]!,level:5,limit:50}));
    await benchmark('same-name-search',()=>kit.search(null,{keyword:samples.sameNamePairs[3]!.sourceName,limit:50}));
    await benchmark('code-search',()=>kit.search(null,{keyword:codes[4]!,limit:50}));
    evidence.passed=true;evidence.completedAt=new Date().toISOString();
    console.error('[full] all 665276 actual source rows, activation, replay, samples and performance verified');
  } catch(error) {
    evidence.failure=error instanceof Error?{name:error.name,message:error.message,stack:error.stack}:String(error);
    throw error;
  } finally {
    capture=null;timings.total=performance.now()-started;
    evidence.containerEnvironment=await readFile(join(reportDirectory,'container-environment.json'),'utf8').then(JSON.parse).catch(()=>({observed:false}));
    evidence.process={peakRssKiB:process.resourceUsage().maxRSS,memory:process.memoryUsage(),note:'Verifier peak; child CLI peaks recorded in progress logs when available.'};
    await json(join(reportDirectory,'full-verification.json'),evidence);await pool.end();
  }
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const args=process.argv.slice(2);
  const connection=JSON.parse(process.env.AREA_KIT_TEST_POSTGRES??'null');
  if(!connection)throw new Error('Only the isolated verify-full runner supplies the connection');
  await runFullVerification({sourceDirectory:args[args.indexOf('--data-dir')+1]!,reportDirectory:args[args.indexOf('--report-dir')+1]!,connection});
}
