import assert from 'node:assert/strict';
import {access,readFile,writeFile,copyFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
const args=process.argv.slice(2), root=fileURLToPath(new URL('../',import.meta.url));
if(args[0]==='--data-dir'&&args.length===2) {
  const child=spawn(process.execPath,[join(root,'scripts/verify-pack.mjs'),'--browser-only',...args],{stdio:'inherit'});
  process.exitCode=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',code=>done(code??1));});
} else {
  assert.equal(args.length,2);assert.equal(args[0],'--consumer-dir');
  const consumer=resolve(args[1]), session=JSON.parse(await readFile(join(consumer,'verification-session.json'),'utf8'));
  const report={passed:false,verified:false,startedAt:new Date().toISOString()};
  try {
    assert.equal(session.token,process.env.AREA_VERIFICATION_SESSION,'Internal browser mode requires the live parent session');
    process.kill(session.parentPid,0);process.kill(session.serverPid,0);
    assert.equal((await fetch(session.origin+'/api/area-kit/dataset',{headers:{cookie:'area-test-session=acceptance'}})).status,200);
    await access(session.executablePath);
    await copyFile(join(root,'test/browser/area-flow.test.ts'),join(consumer,'area-flow.test.ts'));
    const child=spawn(process.execPath,['--import','tsx','area-flow.test.ts'],{cwd:consumer,env:{...process.env,AREA_BROWSER_SESSION:JSON.stringify(session)},stdio:'inherit'});
    const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',value=>done(value??1));});
    assert.equal(code,0,'Real browser flow failed');
    Object.assign(report,{passed:true,verified:true,...JSON.parse(await readFile(join(consumer,'browser-result.json'),'utf8'))});
  } catch(error) {Object.assign(report,{failure:error.message});throw error;} finally {await writeFile(join(session.artifacts,'browser-verification.json'),JSON.stringify(report,null,2));}
}
