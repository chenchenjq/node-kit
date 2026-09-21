/** Standalone acceptance runner, copied into and executed by the installed consumer. */
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium,type Page} from 'playwright-core';
const session=JSON.parse(process.env.AREA_BROWSER_SESSION!) as {origin:string;artifacts:string;executablePath:string};
const browser=await chromium.launch({executablePath:session.executablePath,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
const external:string[]=[],errors:string[]=[],checks:string[]=[];let active:Page|undefined;
async function until(fn:()=>Promise<boolean>,message:string){for(let i=0;i<600;i++){if(await fn())return;await new Promise(done=>setTimeout(done,100));}throw Error(message);}
async function select(page:Page,level:number,code:string){const select=page.getByLabel(`第${level}级区域`,{exact:true});await until(async()=>await select.locator(`option[value="${code}"]`).count()>0,`Missing option ${code}`);await select.selectOption(code);}
try {
  for(const width of [1280,390]){
    const context=await browser.newContext({viewport:{width,height:900}});
    context.setDefaultTimeout(60000);context.setDefaultNavigationTimeout(120000);
    await context.addCookies([{name:'area-test-session',value:'acceptance',url:session.origin}]);
    await context.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin!==session.origin){external.push(url.hostname);await route.abort();}else await route.continue();});
    const page=await context.newPage();active=page;page.on('pageerror',error=>errors.push(error.message));
    await page.goto(session.origin+'/areas');
    await until(()=>page.getByRole('button',{name:'保存地址',exact:true}).isDisabled(),'Initial submit must be disabled');
    const province=page.getByLabel('第1级区域',{exact:true});
    await until(async()=>await province.locator('option[value="11"]').count()>0&&await province.isEnabled(),'Province keyboard input ready');
    await province.focus();await province.press('ArrowDown');
    await until(async()=>await province.inputValue()!=='','Native select responds to keyboard');
    await select(page,1,'13');await select(page,2,'1301');await select(page,3,'130102');
    await until(()=>page.getByRole('button',{name:'保存地址',exact:true}).isEnabled(),'Selection validation');
    await page.getByRole('button',{name:'保存地址',exact:true}).click();await page.getByText('已保存：河北省 / 石家庄市 / 长安区',{exact:true}).waitFor();
    await page.screenshot({path:join(session.artifacts,`selection-${width}.png`),fullPage:true});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Selection horizontally overflows');
    await page.getByRole('button',{name:'清空选择',exact:true}).click();await until(()=>page.getByRole('button',{name:'保存地址',exact:true}).isDisabled(),'Clear submit');
    const search=page.getByLabel('搜索区域',{exact:true});await search.fill('朝阳区');await search.press('Enter');
    const results=page.getByRole('list',{name:'区域搜索结果'});await results.waitFor();assert((await results.innerText()).includes('110105'));assert((await results.innerText()).includes('220104'));
    await search.press('Escape');await results.waitFor({state:'hidden'});await search.press('Enter');await results.waitFor();await results.getByRole('button').filter({hasText:'110105'}).click();await until(async()=>await page.getByLabel('第3级区域',{exact:true}).inputValue()==='110105','Search path fill');
    checks.push(`select/submit/clear/keyboard/same-name search/path fill/no overflow ${width}`);
    // Keep transport unavailable until the retry UI appears, then retry the real database query.
    await page.getByRole('button',{name:'清空选择',exact:true}).click();let rejectChildren=true;
    await page.route('**/api/area-kit/children?**',async route=>{if(rejectChildren)await route.abort('failed');else await route.continue();});
    await select(page,1,'13');await page.getByRole('button',{name:'重试加载第2级区域'}).waitFor();rejectChildren=false;await page.getByRole('button',{name:'重试加载第2级区域'}).click();await select(page,2,'1301');await page.unroute('**/api/area-kit/children?**');
    // Race: delay a real response; changing the parent must invalidate it.
    let pending:Promise<void>|undefined;
    await page.route('**/api/area-kit/children?**',async route=>{if(new URL(route.request().url()).searchParams.get('parentCode')==='13'){pending=(async()=>{const response=await route.fetch();await new Promise(done=>setTimeout(done,500));await route.fulfill({response}).catch(()=>{});})();await pending;}else await route.continue();});
    await select(page,1,'11');await select(page,1,'13');await until(async()=>pending!==undefined,'Delayed real response started');await select(page,1,'11');await select(page,2,'1101');if(pending)await pending;assert.equal(await page.getByLabel('第1级区域',{exact:true}).inputValue(),'11');assert.equal(await page.getByLabel('第2级区域',{exact:true}).inputValue(),'1101');await page.unroute('**/api/area-kit/children?**');
    checks.push(`transport retry and real-response race ${width}`);
    await page.goto(session.origin+'/admin/areas');await page.getByLabel('编码过滤',{exact:true}).fill('130102001001');await page.getByRole('list',{name:'区域列表'}).getByRole('button').filter({hasText:'130102001001'}).click();
    const label=`验收社区${width}`;await page.getByLabel('展示名称',{exact:true}).fill(label);
    const save=page.waitForResponse(response=>response.url().includes('/admin/presentation')&&response.request().method()==='PATCH');await page.getByRole('button',{name:'保存展示设置',exact:true}).click();const saved=await save;assert(saved.ok());assert.equal((await saved.json()).data.label,label);await until(()=>page.getByRole('button',{name:'保存展示设置',exact:true}).isEnabled(),'Save completed');
    await page.getByLabel('业务停用',{exact:true}).check();const disable=page.waitForResponse(response=>response.url().includes('/admin/presentation')&&response.request().method()==='PATCH');await page.getByRole('button',{name:'保存展示设置',exact:true}).click();assert((await disable).ok());await until(()=>page.getByRole('button',{name:'保存展示设置',exact:true}).isEnabled(),'Save completed');const disabledNode=await context.request.get(session.origin+'/api/area-kit/region?code=130102001001');assert.equal((await disabledNode.json()).data.effectiveEnabled,false);
    await page.getByLabel('业务停用',{exact:true}).uncheck();const restore=page.waitForResponse(response=>response.url().includes('/admin/presentation')&&response.request().method()==='PATCH');await page.getByRole('button',{name:'保存展示设置',exact:true}).click();assert((await restore).ok());await until(()=>page.getByRole('button',{name:'保存展示设置',exact:true}).isEnabled(),'Save completed');
    await page.getByLabel('展示名称',{exact:true}).fill('');const reset=page.waitForResponse(response=>response.url().includes('/admin/presentation')&&response.request().method()==='PATCH');await page.getByRole('button',{name:'保存展示设置',exact:true}).click();assert((await reset).ok());await until(()=>page.getByRole('button',{name:'保存展示设置',exact:true}).isEnabled(),'Save completed');
    await page.getByRole('button',{name:'重置过滤',exact:true}).click();await page.getByLabel('层级过滤',{exact:true}).selectOption('3');await page.getByRole('button',{name:'加载更多',exact:true}).waitFor();const before=await page.getByRole('list',{name:'区域列表'}).getByRole('listitem').count();await page.getByRole('button',{name:'加载更多',exact:true}).click();await until(async()=>await page.getByRole('list',{name:'区域列表'}).getByRole('listitem').count()>before,'Pagination appends actual rows');
    await page.screenshot({path:join(session.artifacts,`manager-${width}.png`),fullPage:true});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Manager horizontally overflows');
    checks.push(`admin save/disable/restore/pagination/no overflow ${width}`);await context.close();
  }
  assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
  await writeFile('browser-result.json',JSON.stringify({checks,externalAttempts:external.length,pageErrors:errors,browser:await browser.version(),viewports:[1280,390]},null,2));
}catch(error){await active?.screenshot({path:join(session.artifacts,'browser-failure.png'),fullPage:true}).catch(()=>{});throw error;}finally{await browser.close();}
