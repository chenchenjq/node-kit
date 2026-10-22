import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { readFile, writeFile, readdir, access } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { providerSeeds } from "../dist/catalog.js";
const artifact = new URL("../artifacts/", import.meta.url),
  verification = JSON.parse(
    await readFile(new URL("verification.json", artifact), "utf8"),
  );
const consumer = process.env.AI_KIT_TEST_CONSUMER ?? verification.consumer;
let executablePath = process.env.CHROMIUM_BINARY;
if (!executablePath) {
  const cache = join(homedir(), ".cache/ms-playwright");
  for (const folder of (await readdir(cache))
    .filter((x) => /^chromium-/.test(x))
    .sort()
    .reverse()) {
    for (const suffix of ["chrome-linux/chrome", "chrome-linux64/chrome"]) {
      const candidate = join(cache, folder, suffix);
      try {
        await access(candidate);
        executablePath = candidate;
        break;
      } catch {}
    }
    if (executablePath) break;
  }
}
if (!executablePath)
  throw new Error("Provide CHROMIUM_BINARY pointing to installed Chromium");
const net = createServer();
await new Promise((r) => net.listen(0, "127.0.0.1", r));
const port = net.address().port;
await new Promise((r) => net.close(r));
const server = spawn(
  process.execPath,
  [
    "node_modules/next/dist/bin/next",
    "start",
    "-p",
    String(port),
    "-H",
    "127.0.0.1",
  ],
  {
    cwd: consumer,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
  },
);
let output = "";
server.stdout.on("data", (b) => (output += b));
server.stderr.on("data", (b) => (output += b));
const origin = `http://127.0.0.1:${port}`;
let browser;
try {
  let ready = false;
  for (let n = 0; n < 100; n++) {
    try {
      if ((await fetch(origin)).ok) {
        ready = true;
        break;
      }
    } catch {}
    if (server.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!ready) throw new Error(`Next failed to start: ${output.slice(-1500)}`);
  console.log("Browser: Next ready");
  browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox"],
  });
  console.log("Browser: Chromium launched");
  const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    }),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let connections = [
      {
        id: "c",
        name: "文本连接",
        providerCode: "qwen",
        protocol: "openai-chat",
        baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        enabled: true,
        revision: 1,
        hasCredential: true,
        testedRevision: null,
      },
    ],
    plans = [
      {
        id: "p",
        revision: 1,
        code: "business-proof",
        name: "业务验证",
        connectionId: "c",
        modelId: "qwen-plus",
        enabled: true,
        isDefault: true,
        systemPrompt: null,
        parameters: {},
      },
    ],
    savedConnection,
    savedPlan;
  const result = {
    text: "OK",
    reasoning: "",
    code: "business-proof",
    providerCode: "qwen",
    modelId: "qwen-plus",
    status: "completed",
    finishReason: "stop",
    durationMs: 1,
    requestId: null,
    usage: null,
  };
  await page.route("**/api/ai-kit/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname.split("/api/ai-kit/")[1],
      value = request.postDataJSON();
    let data;
    if (request.method() === "GET")
      data =
        path === "admin/providers"
          ? providerSeeds
          : path === "admin/connections"
            ? connections
            : path === "admin/plans"
              ? plans
              : plans.map(({ code, name, modelId, isDefault }) => ({
                  code,
                  name,
                  modelId,
                  isDefault,
                  providerCode: "qwen",
                }));
    else if (path === "admin/test-draft")
      data = {
        status: "incomplete",
        result: {
          ...result,
          text: "",
          status: "incomplete",
          finishReason: "length",
        },
        error: null,
        durationMs: 1,
      };
    else if (path === "admin/connections") {
      savedConnection = value;
      connections = [
        {
          ...connections[0],
          ...value,
          revision: 2,
          hasCredential: true,
          testedRevision: null,
        },
      ];
      delete connections[0].apiKey;
      data = connections[0];
    } else if (path === "admin/plans") {
      savedPlan = value;
      plans.push({
        ...value,
        id: "new",
        revision: 1,
        systemPrompt: value.systemPrompt ?? null,
        parameters: value.parameters ?? {},
      });
      data = plans.at(-1);
    } else if (path === "stream") {
      await route.fulfill({
        status: 200,
        contentType: "application/x-ndjson",
        body:
          JSON.stringify({ type: "text-delta", delta: "OK" }) +
          "\n" +
          JSON.stringify({ type: "finish", result }) +
          "\n",
      });
      return;
    } else data = null;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data }),
    });
  });
  console.log("Browser: page created");
  await page.goto(origin);
  console.log("Browser: page loaded");
  await page.getByRole("heading", { name: "AI 连接与调用方案" }).waitFor();
  if (
    (await page
      .getByLabel("厂商", { exact: true })
      .locator("option")
      .count()) !== 9
  )
    throw new Error("Nine dictionary vendors were not rendered");
  await page.getByLabel("选择连接").selectOption("c");
  await page
    .getByLabel("API Key", { exact: true })
    .fill("browser-only-mock-key");
  if (
    await page
      .getByRole("button", { name: "测试当前表单", exact: true })
      .isEnabled()
  )
    throw new Error("Fee acknowledgement missing");
  await page.getByLabel("我知道测试会调用模型并可能产生费用").check();
  await page.getByRole("button", { name: "测试当前表单", exact: true }).click();
  await page
    .getByText("未完成：预算耗尽或未产生最终文本", { exact: false })
    .waitFor();
  if (
    (await page.getByLabel("API Key", { exact: true }).inputValue()) !==
    "browser-only-mock-key"
  )
    throw new Error("Test discarded unsaved key");
  await page.getByRole("button", { name: "保存连接", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector("input[type=password]")?.value === "",
  );
  if (savedConnection?.apiKey !== "browser-only-mock-key")
    throw new Error("Wrong key saved after test");
  await page.getByLabel("方案 code", { exact: true }).fill("browser-custom");
  await page.getByLabel("方案名称", { exact: true }).fill("手填验证");
  await page.getByLabel("模型 ID", { exact: true }).fill("Case-Sensitive-ID");
  await page.getByRole("button", { name: "保存方案", exact: true }).click();
  await page
    .getByText("手填验证 · browser-custom", { exact: true })
    .waitFor({ state: "attached" });
  if (savedPlan?.modelId !== "Case-Sensitive-ID")
    throw new Error("Model ID changed");
  await page.getByLabel("用户文本", { exact: true }).fill("仅验证浏览器流程");
  await page.getByRole("button", { name: "生成文本", exact: true }).click();
  await page.getByText(/生成完成.*usage unknown/).waitFor();
  if ((await page.getByLabel("生成正文").textContent()) !== "OK")
    throw new Error("No final text");
  await page.screenshot({
    path: new URL("ui-desktop.png", artifact).pathname,
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  if (
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  )
    throw new Error("Mobile horizontal overflow");
  await page.screenshot({
    path: new URL("ui-mobile.png", artifact).pathname,
    fullPage: true,
  });
  if (errors.length)
    throw new Error(`Browser runtime errors: ${errors.join(", ")}`);
  await writeFile(
    new URL("browser-verification.json", artifact),
    JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        consumer,
        browser: "Chromium",
        checks: [
          "desktop 1280px",
          "mobile 390px without overflow",
          "9 dictionary vendors",
          "fee acknowledgement",
          "incomplete test",
          "test and save same key",
          "manual exact model ID",
          "NDJSON final text and null usage",
        ],
        backend:
          "HTTP mocked in browser only; separate server tests cover authorization/security; no cloud calls",
      },
      null,
      2,
    ),
  );
  console.log(
    "Chromium desktop/mobile management and text flow PASS (Mock HTTP)",
  );
} finally {
  await browser?.close();
  server.kill("SIGTERM");
}
