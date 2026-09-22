#!/usr/bin/env node
/**
 * 一次性验收脚本（不属于 addr-parse-kit 的包内容，也不进 tgz）：
 * 用真实无头 Chrome 驱动 playground，逐条验证三条行为规则与模式切换/确认流程。
 *
 * 前置（全部在仓库外，避免工作区隐式链接）：
 *   HOST=/home/meteor/pg-host && rm -rf $HOST && mkdir -p $HOST
 *   # package.json 依赖：file:<artifacts/<sha>.tgz> + next/react/react-dom（版本取包 devDependencies）
 *   TMPDIR=/home/meteor/tmp npm install
 *   cp -r node_modules/addr-parse-kit/examples/next/. .
 *   TMPDIR=/home/meteor/tmp NODE_ENV=production node node_modules/next/dist/bin/next build
 *   NODE_ENV=production node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3317
 *   ORIGIN=http://127.0.0.1:3317 node .scratch/addr-parse-kit/playground-browser-check.mjs
 *
 * 浏览器来自 playwright-core（工作区已有）+ 系统 Chrome：executablePath=/usr/bin/google-chrome。
 */
import { chromium } from "file:///home/node-kit/node_modules/playwright-core/index.mjs";
import assert from "node:assert/strict";

const origin = process.env.ORIGIN ?? "http://127.0.0.1:3317";
const log = [];
const check = (name, fn) => fn().then((detail) => log.push(`PASS ${name}${detail ? ` — ${detail}` : ""}`), (error) => { log.push(`FAIL ${name} — ${error.message}`); throw error; });

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage();
page.setDefaultTimeout(20_000);

const sec = (title) => page.locator("section").filter({ has: page.locator("h2", { hasText: new RegExp(`^${title}`) }) });
const grid = () => page.locator("table.grid");
const rowState = (label) => page.evaluate((label) => {
  const tr = [...document.querySelectorAll("table.grid tr")].find((r) => (r.querySelector("td")?.textContent ?? "").trim().startsWith(label));
  if (!tr) return null;
  const control = tr.querySelector("select, input, textarea");
  return { label: (tr.querySelector("td")?.textContent ?? "").trim(), value: control?.value ?? null, code: tr.querySelector("code")?.textContent?.trim() ?? null };
}, label);
const optionsOf = (label) => page.evaluate((label) => {
  const tr = [...document.querySelectorAll("table.grid tr")].find((r) => (r.querySelector("td")?.textContent ?? "").trim().startsWith(label));
  const select = tr?.querySelector("select");
  return select ? [...select.options].map((o) => ({ value: o.value, text: o.textContent?.trim() ?? "" })) : [];
}, label);

try {
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await check("页面渲染", async () => {
    const h1 = await page.locator("h1").textContent();
    assert.match(h1 ?? "", /addr-parse-kit 示例/);
    return h1;
  });

  // 规则二：歧义不预选
  await page.getByRole("button", { name: "重名区县（歧义）" }).click();
  await page.locator("section").first().getByRole("button", { name: "解析" }).click();
  await sec("2. 候选与警告").waitFor();
  await check("歧义样本不预选任何候选", async () => {
    const count = await sec("2. 候选与警告").locator("ol > li").count();
    assert.ok(count >= 2, `歧义样本只给出 ${count} 条候选`);
    assert.equal(await sec("3. 手工修正").count(), 0, "候选未经点击就被填进了表单");
    const status = await sec("2. 候选与警告").locator("p code").first().textContent();
    return `${count} 条候选，status=${status}`;
  });

  await sec("2. 候选与警告").locator("ol > li").first().getByRole("button", { name: "用这条候选填充表单" }).click();
  await sec("3. 手工修正").waitFor();
  await check("默认只填空项：已有电话未被覆盖", async () => {
    const phone = await rowState("电话");
    assert.equal(phone?.value, "13600007777", `电话被改写为 ${phone?.value}`);
    const conflict = await sec("3. 手工修正").locator(".conflict").textContent();
    assert.match(conflict ?? "", /默认只填空项、未覆盖/);
    assert.match(conflict ?? "", /13600007777/);
    return conflict?.replace(/\s+/g, " ").slice(0, 90);
  });

  await sec("3. 手工修正").locator(".conflict input[type=checkbox]").check();
  await sec("2. 候选与警告").locator("ol > li").first().getByRole("button", { name: "用这条候选填充表单" }).click();
  await check("显式确认覆盖后才写入解析值", async () => {
    const phone = await rowState("电话");
    assert.equal(phone?.value, "13200008888", `勾选覆盖后电话仍是 ${phone?.value}`);
    return phone.value;
  });

  // 规则三：换区域清下级
  await page.getByRole("button", { name: "标准四级 + 门牌" }).click();
  await page.locator("section").first().getByRole("button", { name: "解析" }).click();
  await sec("2. 候选与警告").waitFor();
  await sec("2. 候选与警告").locator("ol > li").first().getByRole("button", { name: "用这条候选填充表单" }).click();
  await sec("3. 手工修正").waitFor();
  await check("标准样本四级填充并保留门牌", async () => {
    const state = Object.fromEntries(await Promise.all(["省", "市", "区县", "街道"].map(async (label) => [label, await rowState(label)])));
    assert.ok(state.省?.value && state.市?.value && state.区县?.value && state.街道?.value, `四级未齐全：${JSON.stringify(state)}`);
    const detail = await rowState("详细地址");
    assert.match(detail?.value ?? "", /18 号/, `门牌丢失：${detail?.value}`);
    return `${state.省.code}/${state.市.code}/${state.区县.code}/${state.街道.code} · ${detail?.value}`;
  });

  const before = {
    province: await rowState("省"),
    city: await rowState("市"),
    district: await rowState("区县"),
    street: await rowState("街道"),
  };
  const provinces = await optionsOf("省");
  const other = provinces.find((option) => option.value !== "" && option.value !== before.province?.value);
  assert.ok(other, "省份下拉里没有第二个选项");
  await grid().locator("tr").filter({ has: page.locator("td", { hasText: /^省/ }) }).locator("select").selectOption(other.value);
  await check("换省后清空全部更深层级", async () => {
    const after = { city: await rowState("市"), district: await rowState("区县"), street: await rowState("街道") };
    for (const [slot, state] of Object.entries(after)) assert.equal(state?.value, "", `${slot} 残留旧代码 ${state?.value}`);
    return `${before.province?.code} → ${other.value}（${other.text}），市/区县/街道代码 = ${after.city?.code}/${after.district?.code}/${after.street?.code}`;
  });

  const slotRow = (label) => grid().locator("tr").filter({ has: page.locator("td", { hasText: new RegExp(`^${label}`) }) });
  const waitOptions = async (label, count) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const items = await optionsOf(label);
      if (items.length >= count) return items;
      await new Promise((done) => setTimeout(done, 50));
    }
    throw new Error(`${label} 下拉在 5 秒内没有加载出 ${count} 个选项`);
  };
  await grid().locator("tr").filter({ has: page.locator("td", { hasText: /^省/ }) }).locator("select").selectOption(before.province.value);
  await check("逐级重选后四级代码可完整复原", async () => {
    await waitOptions("市", 2);
    await slotRow("市").locator("select").selectOption(before.city.value);
    const districtOptions = await waitOptions("区县", 2);
    await slotRow("区县").locator("select").selectOption(before.district.value);
    const streetOptions = await waitOptions("街道", 2);
    await slotRow("街道").locator("select").selectOption(before.street.value);
    const state = Object.fromEntries(await Promise.all(["省", "市", "区县", "街道"].map(async (label) => [label, await rowState(label)])));
    assert.deepEqual([state.省?.value, state.市?.value, state.区县?.value, state.街道?.value],
      [before.province.value, before.city.value, before.district.value, before.street.value],
      `复原后代码不一致：${JSON.stringify(state)}`);
    assert.ok(districtOptions.some((option) => option.value === before.district.value), "区县列表里没有原代码选项");
    assert.ok(streetOptions.some((option) => option.value === before.street.value), "街道列表里没有原代码选项");
    return `${state.省.code}/${state.市.code}/${state.区县.code}/${state.街道.code}`;
  });

  // 模式切换：隐藏街道时按原文并回，可复原
  const streetValue = (await rowState("街道"))?.value;
  const streetName = (await optionsOf("街道")).find((option) => option.value === streetValue)?.text ?? "";
  const previewText = async () => (await sec("4. 重组预览").textContent()) ?? "";
  const previewAddress = async () => ((await sec("4. 重组预览").locator("p").first().textContent()) ?? "").trim();
  const previewLine = async () => ((await sec("4. 重组预览").locator("p").nth(1).textContent()) ?? "").trim();
  const original = { address: await previewAddress(), line: await previewLine() };
  await sec("3. 手工修正").getByRole("radio", { name: "不输出街道（并入详细地址）" }).check();
  await check("切到不输出街道：按原文并入且不丢字", async () => {
    const text = await previewText();
    assert.match(text, /已并入详细地址，未丢弃/);
    assert.ok(streetName && text.includes(streetName), `并回提示里没有街道原文：${text.slice(0, 200)}`);
    const address = await previewAddress();
    assert.ok(address.includes(streetName), `预览地址丢了街道：${address}`);
    const detail = await rowState("详细地址");
    assert.match(detail?.value ?? "", /18 号/, `并回过程改了明细：${detail?.value}`);
    // 并回只在街道原文与明细之间插入一个分隔空格，去掉空白后两种模式必须逐字一致。
    assert.equal(address.replace(/\s+/g, ""), original.address.replace(/\s+/g, ""), `并回丢字：${original.address} → ${address}`);
    return address;
  });
  const withoutStreet = { address: await previewAddress(), line: await previewLine() };
  await sec("3. 手工修正").getByRole("radio", { name: "输出到街道" }).check();
  await check("切回输出到街道：预览复原且无完整性问题", async () => {
    const text = await previewText();
    assert.doesNotMatch(text, /已并入详细地址/);
    const withStreet = { address: await previewAddress(), line: await previewLine() };
    assert.equal(withStreet.address, original.address, `切回后预览未复原：${original.address} → ${withStreet.address}`);
    assert.equal(withStreet.line, original.line, "切回后整行未复原");
    assert.notEqual(withoutStreet.address, withStreet.address, "并回时插入的分隔空格没被撤销");
    const integrity = await sec("4. 重组预览").locator(".error").count();
    assert.equal(integrity, 0, "预览里有完整性问题");
    assert.match(withStreet.line, /王小满/);
    return withStreet.line;
  });

  // 校验与确认
  await sec("3. 手工修正").getByRole("button", { name: "校验区域路径" }).click();
  await check("路径校验通过", async () => {
    const text = (await sec("3. 手工修正").locator(".ok").textContent()) ?? "";
    assert.match(text, /路径校验通过/);
    return text.trim();
  });
  await check("未勾选“我已核对”时确认按钮禁用", async () => {
    const button = sec("5. 确认并交给宿主保存").getByRole("button", { name: "确认保存" });
    assert.equal(await button.isDisabled(), true, "确认按钮在未勾选时可用");
    return "disabled";
  });
  await sec("5. 确认并交给宿主保存").locator("input[type=checkbox]").check();
  await sec("5. 确认并交给宿主保存").getByRole("button", { name: "确认保存" }).click();
  await check("确认后返回落库记录", async () => {
    const pre = sec("5. 确认并交给宿主保存").locator("pre");
    await pre.waitFor();
    const record = JSON.parse((await pre.textContent()) ?? "{}");
    assert.ok(record.id, "返回体缺少记录 id");
    assert.equal(record.provinceCode, before.province?.value);
    assert.equal(record.parserVersion, "0.0.0", "包版本应由服务端补齐");
    assert.ok(!("recipientName" in record) || record.recipientName === "王小满");
    return `id=${String(record.id).slice(0, 8)}… ${record.provinceCode}/${record.cityCode}/${record.districtCode}/${record.streetCode} manualEdits=${record.manualEdits}`;
  });

  await check("页面上没有把收件原文写进 URL", async () => {
    const url = page.url();
    assert.ok(!/text=|name=|phone=/i.test(url), `URL 含收件信息：${url}`);
    return url;
  });

  // 分支样例：直辖市分组节点 + 分机 + 备注
  await page.getByRole("button", { name: "直辖市 + 分机 + 备注" }).click();
  await page.locator("section").first().getByRole("button", { name: "解析" }).click();
  await sec("2. 候选与警告").waitFor();
  await sec("2. 候选与警告").locator("ol > li").first().getByRole("button", { name: "用这条候选填充表单" }).click();
  await sec("3. 手工修正").waitFor();
  await check("直辖市分组节点落在市级槽位，分机与备注按字段留存", async () => {
    const state = Object.fromEntries(await Promise.all(["省", "市", "区县", "街道", "分机"].map(async (label) => [label, await rowState(label)])));
    assert.equal(state.省?.value, "11", `省不是北京市：${JSON.stringify(state.省)}`);
    assert.equal(state.市?.value, "1101", `市级槽位没有落在分组节点“市辖区”：${JSON.stringify(state.市)}`);
    assert.ok(state.区县?.value && state.街道?.value, `区县/街道未填：${JSON.stringify(state)}`);
    assert.equal(state.分机?.value, "802", `分机识别为 ${state.分机?.value}`);
    const detail = await rowState("详细地址");
    assert.match(detail?.value ?? "", /902/, `房号丢失：${detail?.value}`);
    return `11/1101/${state.区县.code}/${state.街道.code} 分机=${state.分机.value} 明细=${detail?.value}`;
  });
  await sec("3. 手工修正").getByRole("button", { name: "校验区域路径" }).click();
  await check("含分组节点的路径校验通过", async () => {
    const text = (await sec("3. 手工修正").locator(".ok").textContent()) ?? "";
    assert.match(text, /路径校验通过/);
    return text.trim();
  });

  // 分支样例：掩码号码原样保留
  await page.getByRole("button", { name: "掩码号码" }).click();
  await page.locator("section").first().getByRole("button", { name: "解析" }).click();
  await sec("2. 候选与警告").waitFor();
  await sec("2. 候选与警告").locator("ol > li").first().getByRole("button", { name: "用这条候选填充表单" }).click();
  await sec("3. 手工修正").waitFor();
  await check("掩码号码原样展示、不猜测数字", async () => {
    const masked = await sec("3. 手工修正").locator("tr").filter({ has: page.locator("td", { hasText: /^掩码号码/ }) }).textContent();
    assert.match(masked ?? "", /138\*{4}6721/, `掩码号码行：${masked}`);
    assert.match(masked ?? "", /不猜测缺失数字/);
    return masked?.replace(/\s+/g, " ").trim().slice(0, 60);
  });

  // 分支样例：完全未匹配仍可人工补全
  await page.getByRole("button", { name: "完全未匹配" }).click();
  await page.locator("section").first().getByRole("button", { name: "解析" }).click();
  await sec("2. 候选与警告").waitFor();
  await check("未匹配样本给出 unmatched 且不预选", async () => {
    const status = await sec("2. 候选与警告").locator("p code").first().textContent();
    assert.equal(status, "unmatched", `状态是 ${status}`);
    assert.equal(await sec("3. 手工修正").count(), 0, "未匹配结果被自动填进表单");
    return status;
  });
} catch (error) {
  await page.screenshot({ path: "/home/meteor/pg-host/failure.png", fullPage: true }).catch(() => {});
  console.error(error.message);
} finally {
  await browser.close();
  console.log(log.join("\n"));
  console.log(log.some((line) => line.startsWith("FAIL")) ? "BROWSER_CHECK_FAIL" : `BROWSER_CHECK_OK（${log.length} 项）`);
}
