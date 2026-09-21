import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {access,copyFile,cp,mkdir,mkdtemp,readFile,realpath,unlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import net from 'node:net';
import {postgresTestEnvironment} from './postgres-test-environment.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const args=process.argv.slice(2),browserOnly=args[0]==='--browser-only';if(browserOnly)args.shift();
assert.equal(args[0],'--data-dir');assert.equal(args.length,2);
const data=resolve(args[1]), artifacts=join(root,'artifacts');
await mkdir(artifacts,{recursive:true});
const resume=process.env.AREA_PACK_RESUME?JSON.parse(await readFile(join(artifacts,'pack-verification.json'),'utf8')):null;
if(resume)assert.equal(resume.workspace,resolve(process.env.AREA_PACK_RESUME));
const workspace=resume?.workspace??await mkdtemp(join(tmpdir(),'area-kit-pack-'));
const evidence={passed:false,verified:false,browserOnly,workspace,startedAt:new Date().toISOString(),checks:resume?.checks??[],...(resume?{resumedFrom:resume.startedAt}:{})};
const started=Date.now();
const cleanEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>!['NODE_PATH','NODE_OPTIONS'].includes(key)));
export function run(command,args,cwd,env=cleanEnv) {
  return new Promise((done,reject)=>{
    const child=spawn(command,args,{cwd,env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
    child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;if(args.includes('import')&&args[0]?.endsWith('area-kit.mjs'))process.stderr.write(chunk);});
    child.once('error',reject);child.once('exit',code=>{if(code===0)done({stdout,stderr});else {const error=new Error(`${command} ${args.slice(0,2).join(' ')} failed (${code})\n${stdout}\n${stderr}`);Object.assign(error,{stdout,stderr});reject(error);}});
  });
}
async function step(name,fn){
  console.log(`[pack] ${name}`);const start=Date.now();
  for(;;){
    try{const result=await fn();evidence.checks.push({name,passed:true,elapsedMs:Date.now()-start});return result;}
    catch(error){
      if(name!=='real browser desktop and narrow flows'||process.env.AREA_PACK_DEBUG!=='1')throw error;
      (evidence.debugAttempts??=[]).push({name,failure:error.message,at:new Date().toISOString()});
      await writeFile(join(artifacts,'browser-debug-failure.json'),JSON.stringify(evidence.debugAttempts,null,2));
      const retry=join(workspace,'retry-browser');
      console.error(`[pack] Browser failed; live DB/Next retained for at most 10 minutes. After fixing the harness, create ${retry} to retry. ${error.message}`);
      let requested=false;
      for(let i=0;i<600;i++){
        try{await access(retry);await unlink(retry);requested=true;break;}catch(cause){if(cause.code!=='ENOENT')throw cause;}
        await new Promise(done=>setTimeout(done,1000));
      }
      if(!requested)throw error;
    }
  }
}
async function put(dir,name,text){await mkdir(join(dir,name,'..'),{recursive:true});await writeFile(join(dir,name),text);}
async function install(name,dependencies){const dir=join(workspace,name);if(resume){assert.equal(resume.sha256,evidence.sha256,'Resume only accepts the identical artifact');assert.equal(JSON.parse(await readFile(join(dir,'package.json'),'utf8')).dependencies['area-kit'],`file:${evidence.tarball}`);assert.equal(await realpath(join(dir,'node_modules/area-kit')),join(dir,'node_modules/area-kit'));return dir;}await mkdir(dir);await put(dir,'package.json',JSON.stringify({name:`area-kit-clean-${name}`,private:true,type:'module',dependencies:{'area-kit':`file:${evidence.tarball}`,...dependencies}}));await run('npm',['install','--no-audit','--no-fund'],dir);assert.equal(await realpath(join(dir,'node_modules/area-kit')),join(dir,'node_modules/area-kit'));return dir;}
async function script(dir,name,text,env){await put(dir,name,text);return run(process.execPath,[name],dir,env);}
async function freePort(){const server=net.createServer();await new Promise(done=>server.listen(0,'127.0.0.1',done));const port=server.address().port;await new Promise(done=>server.close(done));return port;}
async function stop(child){if(!child||child.exitCode!==null||child.signalCode!==null)return;const done=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),10000);await done;clearTimeout(timer);}
async function startNext(dir,env,origin){const child=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',new URL(origin).port],{cwd:dir,env,stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',chunk=>log+=chunk);child.stderr.on('data',chunk=>log+=chunk);for(let i=0;i<120;i++){if(child.exitCode!==null||child.signalCode!==null)throw new Error(log);try{if((await fetch(origin)).ok)return child;}catch{}await new Promise(done=>setTimeout(done,500));}await stop(child);throw new Error('Next startup timeout: '+log);}
try {
  await writeFile(join(artifacts,'pack-verification.json'),JSON.stringify(evidence,null,2));
  await writeFile(join(artifacts,'browser-verification.json'),JSON.stringify({passed:false,verified:false,phase:'not-run'}));
  await writeFile(join(artifacts,'verification.json'),JSON.stringify({passed:false,verified:false,phase:'starting'}));
  await access(join(data,'prepared-source.json'));
  await access(process.env.AREA_BROWSER_EXECUTABLE??'/usr/bin/google-chrome');
  await step('build',()=>run('npm',['run','build'],root));
  await step('tarball inventory',async()=>{
    const {stdout}=await run('npm',['pack','--json','--pack-destination',artifacts],root);await writeFile(join(artifacts,'pack-metadata.json'),stdout);
    const packed=JSON.parse(stdout)[0],tarball=join(artifacts,packed.filename),sha=createHash('sha256').update(await readFile(tarball)).digest('hex');
    evidence.tarball=join(artifacts,`${sha}.tgz`);evidence.sha256=sha;await copyFile(tarball,evidence.tarball);
    const paths=packed.files.map(file=>file.path);evidence.files=paths;
    for(const required of ['dist/index.d.ts','dist/cli.js','scripts/area-kit.mjs','dist/source/manifest.js','migrations/0001-area-kit.sql','README.md','DATABASE.md','DATA-SOURCE.md','AI-USAGE.md'])assert(paths.includes(required),`Missing ${required}`);
    assert(paths.some(path=>path.startsWith('licenses/')));assert(paths.some(path=>path.startsWith('examples/next/')));
    assert(!paths.some(path=>/\.(csv|jsonl|pem|key)$|(^|\/)(artifacts|test|node_modules|\.npmrc|\.env)(\/|$)/.test(path)));
    assert(!paths.some(path=>path.endsWith('.json')&&path!=='package.json'));
  });
  const core=browserOnly?null:await step('core clean install',()=>install('core',{}));
  const node=await step('Node clean install',()=>install('node',{pg:'8.23.0','drizzle-orm':'0.45.2'}));
  const deps=JSON.parse(await readFile(join(root,'package.json'),'utf8')).devDependencies;
  const next=await step('Next clean install',()=>install('next',Object.fromEntries(['next','react','react-dom','typescript','@types/node','@types/react','@types/react-dom','@types/pg','pg','drizzle-orm','tsx','esbuild','playwright-core'].map(name=>[name,deps[name]]))));
  evidence.consumers={...(core?{core}:{}),node,next};evidence.resolutions=Object.fromEntries(await Promise.all(Object.entries(evidence.consumers).map(async([name,dir])=>[name,await realpath(join(dir,'node_modules/area-kit'))])));
  if(core&&!resume?.checks.some(check=>check.name==='optional peers and lazy CLI'&&check.passed))await step('optional peers and lazy CLI',async()=>{
    await script(core,'core.mjs',`import assert from 'node:assert/strict';import {createRequire} from 'node:module';import * as root from 'area-kit';import {createAreaKit} from 'area-kit/server';const require=createRequire(import.meta.url);for(const dep of ['react','pg','drizzle-orm'])assert.throws(()=>require.resolve(dep));const kit=createAreaKit({store:new Proxy({}, {get(){throw Error('store reached before auth');}}),authorize:()=>false});await assert.rejects(kit.listProvinces({}),e=>e.code==='FORBIDDEN');`);
    for(const command of [['prepare','--dir',data],['check','--dir',data,'--report-dir',join(workspace,'core-check')]])await run(process.execPath,['node_modules/area-kit/scripts/area-kit.mjs',...command],core);
    await script(node,'no-react.mjs',`import assert from 'node:assert/strict';import {createRequire} from 'node:module';assert.throws(()=>createRequire(import.meta.url).resolve('react'));`);
  });
  await cp(join(next,'node_modules/area-kit/examples/next'),next,{recursive:true});
  await put(next,'tsconfig.json',JSON.stringify({compilerOptions:{strict:true,skipLibCheck:true,noEmit:true,target:'ES2022',lib:['dom','dom.iterable','esnext'],module:'esnext',moduleResolution:'bundler',jsx:'react-jsx',esModuleInterop:true,allowJs:true,resolveJsonModule:true,isolatedModules:true,plugins:[{name:'next'}]},include:['app/**/*.tsx','app/**/*.ts','lib/**/*.ts','global.d.ts','instrumentation.ts']}));
  await copyFile(join(next,'next.config.mjs'),join(next,'area-example.config.mjs'));
  await put(next,'next.config.mjs',`import example from './area-example.config.mjs';export default {...example,distDir:process.env.AREA_NEXT_DIST??'.next',experimental:{...example.experimental,cpus:2}};`);
  await put(next,'instrumentation.ts',`export async function register(){if(process.env.NEXT_RUNTIME==='nodejs'){const {install}=await import('./lib/test-bootstrap');install();}}`);
  await put(next,'lib/test-bootstrap.ts',`import {Pool} from 'pg';import {createAreaHost,installAreaHost} from './host.js';import {AreaKitError} from 'area-kit/server';export function install(){const pool=new Pool(JSON.parse(process.env.AREA_KIT_TEST_POSTGRES!));installAreaHost(createAreaHost({pool,origin:process.env.AREA_TEST_ORIGIN!,authorize:async()=>true,authenticate:async(request)=>{if(!request.headers.get('cookie')?.includes('area-test-session=acceptance'))throw new AreaKitError('FORBIDDEN');return {};},protectRequest:async(request)=>{if(!['GET','HEAD'].includes(request.method)&&request.headers.get('origin')!==process.env.AREA_TEST_ORIGIN)throw new AreaKitError('FORBIDDEN');},previewPolicy:()=>({}),submissionPolicy:()=>({targetLevel:3,policy:{},versionPolicy:'active-only'}),persist:async(client,selection)=>{await client.query('INSERT INTO acceptance_submissions(selection) VALUES ($1)',[JSON.stringify(selection)]);}}));}`);
  if(!browserOnly)await step('installed documentation types',()=>run(process.execPath,[join(root,'scripts/check-doc-examples.mjs'),'--consumer-dir',next],next));
  await step('consumer TypeScript',()=>run(process.execPath,['node_modules/typescript/bin/tsc','--noEmit'],next));
  await step('esbuild browser positive and negative boundaries',()=>script(next,'boundary.mjs',`import assert from 'node:assert/strict';import {build} from 'esbuild';import {writeFile} from 'node:fs/promises';await writeFile('browser-entry.tsx',"import type {AreaValue} from 'area-kit';import {createAreaClient} from 'area-kit/client';import {AreaCascader} from 'area-kit/react';console.log(createAreaClient,AreaCascader);");const result=await build({absWorkingDir:process.cwd(),entryPoints:['browser-entry.tsx'],platform:'browser',bundle:true,write:false,metafile:true});assert(!Object.keys(result.metafile.inputs).some(path=>/(drizzle-orm|node_modules\\/pg\\/|area-kit\\/dist\\/(server|postgres|source|import))/.test(path)));for(const [entry,method]of [['server','createAreaKit'],['postgres','createDrizzleAreaStore']]){await writeFile('negative.ts',\`import {\${method}} from 'area-kit/\${entry}';console.log(\${method}({}));\`);await assert.rejects(build({entryPoints:['negative.ts'],platform:'browser',bundle:true,write:false,logLevel:'silent'}),e=>/No matching export/.test(e.message));}`));
  const {withPostgres}=await step('load temporary PostgreSQL harness',()=>import('./with-postgres.mjs'));
  await withPostgres(async connection=>{
    const env=postgresTestEnvironment(connection,cleanEnv);env.NEXT_TELEMETRY_DISABLED='1';env.NODE_ENV='production';
    env.AREA_KIT_DATABASE_URL=`postgresql://${encodeURIComponent(connection.user)}:${encodeURIComponent(connection.password)}@${connection.host}:${connection.port}/${connection.database}`;
    const origin=`http://127.0.0.1:${await freePort()}`;env.AREA_TEST_ORIGIN=origin;evidence.origin=origin;
    await step('installed migration',()=>script(node,'migrate.mjs',`import pg from 'pg';import {areaMigrationSql} from 'area-kit/postgres';const pool=new pg.Pool(JSON.parse(process.env.AREA_KIT_TEST_POSTGRES));try{await pool.query(areaMigrationSql('public'));await pool.query('CREATE TABLE acceptance_submissions(id bigserial primary key,selection jsonb NOT NULL)');}finally{await pool.end();}`,env));
    evidence.environment=JSON.parse((await script(node,'environment.mjs',`import pg from 'pg';const pool=new pg.Pool(JSON.parse(process.env.AREA_KIT_TEST_POSTGRES));try{console.log(JSON.stringify({node:process.version,postgres:(await pool.query('SHOW server_version')).rows[0].server_version}));}finally{await pool.end();}`,env)).stdout);
    for(const [entry,method]of [['server','createAreaKit'],['postgres','createDrizzleAreaStore']])await step(`Next negative ${entry}`,async()=>{
      await put(next,'app/boundary/page.tsx',`'use client';import {${method}} from 'area-kit/${entry}';export default function Page(){return <p>{String(${method})}</p>;}`);
      let failed=false;try{await run(process.execPath,['node_modules/next/dist/bin/next','build','--webpack'],next,{...env,AREA_NEXT_DIST:`.negative-${entry}`});}catch(error){assert(/server-only|No matching export|not exported|Server Component|server component/i.test(error.message),error.message);assert(!/Cannot find module|ECONNREFUSED|ENOTFOUND/.test(error.message));await writeFile(join(artifacts,`next-negative-${entry}.log`),error.message);failed=true;}assert(failed,'Sensitive client import unexpectedly built');
    });
    await put(next,'app/boundary/page.tsx',`export default function Page(){return <p>Browser boundary verified</p>;}`);
    await step('Next production build',()=>run(process.execPath,['node_modules/next/dist/bin/next','build','--webpack'],next,env));
    await step('Next real bootstrap and authorization before import',async()=>{
      const probe=await startNext(next,env,origin);
      try {
        assert.equal((await fetch(origin+'/api/area-kit/dataset')).status,403,'Authentication errors must retain FORBIDDEN across server bundles');
        const response=await fetch(origin+'/api/area-kit/dataset',{headers:{cookie:'area-test-session=acceptance'}});
        assert.equal(response.status,503);assert.equal((await response.json()).error.code,'NOT_INITIALIZED');
      }finally{await stop(probe);}
    });
    const imported=await step('installed CLI full source import and activate',()=>run(process.execPath,['node_modules/area-kit/scripts/area-kit.mjs','import','--dir',data,'--report-dir',join(workspace,'import'),'--activate'],node,env));
    evidence.dataset=JSON.parse(imported.stdout);assert.equal(evidence.dataset.status,'ready');assert.equal(evidence.dataset.isActive,true);assert.deepEqual(evidence.dataset.levelCounts,{'1':31,'2':342,'3':2978,'4':41352,'5':620573});await writeFile(join(artifacts,'packed-import.log'),imported.stderr);
    const nodeChecks=`import assert from 'node:assert/strict';import pg from 'pg';import {createAreaKit} from 'area-kit/server';import {createDrizzleAreaStore} from 'area-kit/postgres';const pool=new pg.Pool(JSON.parse(process.env.AREA_KIT_TEST_POSTGRES));try{const kit=createAreaKit({store:createDrizzleAreaStore(pool),authorize:()=>true}),ctx={};const dataset=await kit.getDataset(ctx,{});assert(dataset.isActive);assert.equal((await kit.listProvinces(ctx,{})).items.length,31);assert((await kit.listChildren(ctx,{parentCode:'13'})).items.length>0);assert.equal((await kit.getPath(ctx,{code:'130102001001'})).nodes.length,5);assert((await kit.search(ctx,{keyword:'朝阳区'})).items.some(node=>node.code==='110105'));for(let targetLevel=1;targetLevel<=5;targetLevel++)assert((await kit.validateSelection(ctx,{pathCodes:['13','1301','130102','130102001','130102001001'].slice(0,targetLevel),targetLevel})).accepted);assert.equal((await kit.validateSelection(ctx,{pathCodes:['11','1101'],targetLevel:2})).reason,'NAVIGATION_ONLY');}finally{await pool.end();}`;
    await put(node,'queries.mjs',nodeChecks);
    if(!browserOnly)await step('Node real database reads and target 1–5',()=>run(process.execPath,['queries.mjs'],node,env));
    let server;try {
      server=await step('Next production start',()=>startNext(next,env,origin));
      async function routes(){
        async function request(path,body,method='POST'){const response=await fetch(origin+path,{headers:{cookie:'area-test-session=acceptance',origin,'content-type':'application/json'},...(body?{method,body:JSON.stringify(body)}:{})});const json=await response.json();assert(response.ok,JSON.stringify(json));return json.data;}
        assert.equal((await fetch(origin+'/api/area-kit/dataset')).status,403);
        const dataset=await request('/api/area-kit/dataset');assert(dataset.isActive);
        assert.equal((await request('/api/area-kit/provinces')).items.length,31);
        assert((await request('/api/area-kit/children?parentCode=13')).items.length>0);
        assert.equal((await request('/api/area-kit/path?code=130102001001')).nodes.length,5);
        const page=await request('/api/area-kit/search?keyword='+encodeURIComponent('朝阳区')+'&limit=1');assert(page.hasMore);const page2=await request('/api/area-kit/search?keyword='+encodeURIComponent('朝阳区')+'&limit=1&cursor='+encodeURIComponent(page.nextCursor));assert.notEqual(page.items[0].code,page2.items[0].code);
        for(let targetLevel=1;targetLevel<=5;targetLevel++)assert((await request('/api/area-kit/validate',{datasetId:dataset.datasetId,pathCodes:['13','1301','130102','130102001','130102001001'].slice(0,targetLevel),targetLevel})).accepted);
        assert.equal((await request('/api/area-kit/validate',{pathCodes:['11','1101'],targetLevel:2})).reason,'NAVIGATION_ONLY');
        assert.equal((await request('/api/address-selection',{datasetId:dataset.datasetId,pathCodes:['13','1301','130102']})).code,'130102');
        for(const path of ['/areas','/admin/areas'])assert.equal((await fetch(origin+path)).status,200);
      }
      await step('HTTP routes and real business submit',routes);
      const guard=join(root,'scripts/offline-guard.mjs'),offlineLog=join(artifacts,'offline-requests.jsonl'),preflightLog=join(artifacts,'offline-preflight.jsonl');
      await writeFile(offlineLog,'');await writeFile(preflightLog,'');const offline={...env,NODE_OPTIONS:`--import=${guard}`,AREA_TEST_DB_IP:connection.host,AREA_OFFLINE_LOG:offlineLog};
      await step('offline guard negative preflight',()=>script(node,'offline-preflight.mjs',`import assert from 'node:assert/strict';import http from 'node:http';import https from 'node:https';import net,{connect} from 'node:net';import dns,{lookup} from 'node:dns';import {resolve4} from 'node:dns/promises';import tls from 'node:tls';for(const operation of [()=>fetch('https://example.com'),()=>http.get('http://example.com'),()=>https.get('https://example.com'),()=>net.connect(80,'example.com'),()=>connect({host:'example.com',port:80}),()=>lookup('example.com',()=>{}),()=>resolve4('example.com'),()=>new dns.Resolver().resolve4('example.com',()=>{}),()=>tls.connect({host:'example.com',port:443})]){await assert.rejects(async()=>operation(),/AREA_EXTERNAL_NETWORK_BLOCKED/);}const response=await fetch(process.env.AREA_TEST_ORIGIN);assert(response.ok);`,{...offline,AREA_OFFLINE_LOG:preflightLog}));
      await stop(server);server=null;
      server=await step('Next offline production start',()=>startNext(next,offline,origin));
      await step('offline Node queries',()=>run(process.execPath,['queries.mjs'],node,offline));
      await step('offline HTTP and business submit',routes);
      const session={token:randomUUID(),parentPid:process.pid,serverPid:server.pid,origin,artifacts,executablePath:process.env.AREA_BROWSER_EXECUTABLE??'/usr/bin/google-chrome'};
      await put(next,'verification-session.json',JSON.stringify(session));
      await step('real browser desktop and narrow flows',()=>run(process.execPath,[join(root,'scripts/verify-browser.mjs'),'--consumer-dir',next],next,{...cleanEnv,AREA_VERIFICATION_SESSION:session.token}));
      assert.equal(await readFile(offlineLog,'utf8'),'','Offline acceptance attempted an external connection');
      await step('persisted business submission',()=>script(node,'persisted.mjs',`import assert from 'node:assert/strict';import pg from 'pg';const pool=new pg.Pool(JSON.parse(process.env.AREA_KIT_TEST_POSTGRES));try{assert(Number((await pool.query('SELECT count(*) FROM acceptance_submissions')).rows[0].count)>=3);}finally{await pool.end();}`,offline));
      evidence.offline={mode:'process-level Node network guard; not OS isolation',externalAttempts:0};
    }finally{await stop(server);}
  });
  evidence.passed=true;evidence.verified=true;
}catch(error){evidence.failure=error.message;console.error(error.message);process.exitCode=1;}
finally{evidence.elapsedMs=Date.now()-started;await writeFile(join(artifacts,'pack-verification.json'),JSON.stringify(evidence,null,2));await writeFile(join(artifacts,'verification.json'),JSON.stringify({passed:evidence.passed,verified:evidence.verified,sha256:evidence.sha256,elapsedMs:evidence.elapsedMs,pack:'pack-verification.json',browser:'browser-verification.json',failure:evidence.failure},null,2));console.log(`[pack] ${evidence.passed?'PASS':'FAIL'} evidence: ${artifacts}`);}
