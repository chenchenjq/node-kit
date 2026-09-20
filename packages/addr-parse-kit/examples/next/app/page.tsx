"use client";

import { useEffect, useMemo, useState } from "react";
import type { AddressCandidate, LevelNode, OutputMode, ParseResult } from "addr-parse-kit";
import { formatAddress, formatRecipientLine, toWithoutStreet, validateAddressIntegrity } from "addr-parse-kit";
import {
  applyDetail,
  applyRecipient,
  applyRegion,
  normalized,
  selectionValue,
  slotNode,
  SLOTS,
  SLOT_LABEL,
  type RegionOption,
  type Slot,
} from "../lib/edit";
import type { ConfirmRequest, RegionSelection, SavedAddress } from "../lib/protocol";

const SAMPLES: readonly { label: string; text: string }[] = [
  { label: "标准四级 + 门牌", text: "广东省深圳市南山区粤海街道科技园南路 18 号 3 栋 1205 王小满 13800001111" },
  { label: "重名区县（歧义）", text: "鼓楼区 中山北路 100 号 徐明 13200008888" },
  { label: "带市消歧", text: "江苏省徐州市鼓楼区夹河街 12 号 孙丽 13100009999" },
  { label: "直辖市 + 分机 + 备注", text: "北京市朝阳区建外街道 建国路 88 号 A 座 902 张伟 13700003333 转 802 备注：放前台" },
  { label: "掩码号码", text: "贵州省毕节市大方县顺德街道 交通路 45 号 陈小雨 138****6721" },
  { label: "完全未匹配", text: "公司地址面议 请联系招商部" },
];

/** 模拟宿主表单里已经存在的值：解析结果默认只填空项，不覆盖它。 */
const EXISTING = { phone: "13600007777" } as const;

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await response.json()) as { data?: T; error?: { code: string; message: string } };
  if (!response.ok || body.data === undefined) throw new Error(`${body.error?.code ?? "ERROR"}：${body.error?.message ?? "请求失败"}`);
  return body.data;
}

function selection(node: LevelNode | null): RegionSelection | null {
  if (node === null || node.match === "none") return null;
  return { code: node.code, name: node.name, level: node.level };
}

export default function Playground(): React.JSX.Element {
  const [text, setText] = useState("");
  const [extractRecipient, setExtractRecipient] = useState(true);
  const [allowInferred, setAllowInferred] = useState(false);
  const [maxCandidates, setMaxCandidates] = useState(5);
  const [result, setResult] = useState<ParseResult | null>(null);
  const [draft, setDraft] = useState<AddressCandidate | null>(null);
  const [manualEdits, setManualEdits] = useState(false);
  const [view, setView] = useState<OutputMode>("withStreet");
  const [lists, setLists] = useState<Record<Slot, RegionOption[]>>({ province: [], city: [], district: [], street: [] });
  const [conflicts, setConflicts] = useState<string[]>([]);
  const [overwrite, setOverwrite] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [pathCheck, setPathCheck] = useState<{ ok: boolean; problems: { code: string; reason: string }[] } | null>(null);
  const [saved, setSaved] = useState<SavedAddress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void call<{ items: RegionOption[] }>("/api/regions")
      .then((page) => setLists((current) => ({ ...current, province: page.items })))
      .catch((cause: unknown) => setError(String(cause instanceof Error ? cause.message : cause)));
  }, []);

  const preview = useMemo(() => {
    if (draft === null) return null;
    const folded = view === "withoutStreet" ? toWithoutStreet(draft) : null;
    return {
      address: formatAddress(draft, { mode: view }),
      line: formatRecipientLine(draft, { mode: view }),
      integrity: validateAddressIntegrity(draft),
      folded: folded?.streetFolded ?? null,
    };
  }, [draft, view]);

  async function syncLists(next: AddressCandidate): Promise<void> {
    const children = async (parentCode: string | null): Promise<RegionOption[]> =>
      (await call<{ items: RegionOption[] }>(`/api/regions${parentCode ? `?parentCode=${encodeURIComponent(parentCode)}` : ""}`)).items;
    const districtAnchor = next.city?.code ?? (next.regionGroup?.level === 2 ? next.regionGroup.code : null);
    const loaded = {
      province: lists.province.length ? lists.province : await children(null),
      city: next.province ? await children(next.province.code) : [],
      district: districtAnchor ? await children(districtAnchor) : [],
      street: next.district ? await children(next.district.code) : [],
    };
    setLists(loaded);
  }

  /** 采纳候选：只填空项，已有非空值需要显式确认后才覆盖。 */
  function adopt(candidate: AddressCandidate): void {
    let next = normalized(candidate);
    const found: string[] = [];
    if (EXISTING.phone && EXISTING.phone !== (next.recipient?.phone ?? "")) {
      found.push(`电话（表单已有 ${EXISTING.phone}，解析得到 ${next.recipient?.phone ?? "无"}）`);
      if (!overwrite) next = applyRecipient(next, { phone: EXISTING.phone });
    }
    setDraft(next);
    setConflicts(found);
    setManualEdits(false);
    setPathCheck(null);
    setSaved(null);
    setReviewed(false);
    setError("");
    void syncLists(next);
  }

  async function runParse(): Promise<void> {
    setBusy(true);
    setError("");
    try {
      const body = {
        text,
        extractRecipient,
        allowInferred,
        ...(Number.isInteger(maxCandidates) && maxCandidates >= 1 ? { maxCandidates } : {}),
      };
      setResult(await call<ParseResult>("/api/parse", { method: "POST", body: JSON.stringify(body) }));
      setDraft(null);
      setPathCheck(null);
      setSaved(null);
      setConflicts([]);
      setReviewed(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setResult(null);
    } finally {
      setBusy(false);
    }
  }

  function edit(patch: (current: AddressCandidate) => AddressCandidate): void {
    if (draft === null) return;
    const next = patch(draft);
    setDraft(next);
    setManualEdits(true);
    setPathCheck(null);
    setSaved(null);
    void syncLists(next);
  }

  async function checkPath(): Promise<void> {
    if (draft === null) return;
    const codes = [selection(draft.province), draft.regionGroup !== null ? selection(draft.regionGroup) : selection(draft.city), selection(draft.district), selection(draft.street)]
      .map((item) => item?.code ?? null);
    try {
      setPathCheck(await call<{ ok: boolean; problems: { code: string; reason: string }[] }>("/api/validate", { method: "POST", body: JSON.stringify({ codes }) }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function confirm(): Promise<void> {
    if (draft === null || result === null) return;
    setBusy(true);
    setError("");
    try {
      const payload: ConfirmRequest = {
        candidateId: draft.candidateId,
        view,
        parseStatus: draft.status,
        requiresReview: draft.requiresReview,
        manualEdits,
        province: selection(draft.province),
        city: selection(draft.city),
        district: selection(draft.district),
        street: selection(draft.street),
        regionGroup: selection(draft.regionGroup),
        detailedAddress: draft.detailedAddress,
        recipient: {
          ...(draft.recipient?.name === undefined ? {} : { name: draft.recipient.name }),
          ...(draft.recipient?.phone === undefined ? {} : { phone: draft.recipient.phone }),
          ...(draft.recipient?.phoneExtension === undefined ? {} : { phoneExtension: draft.recipient.phoneExtension }),
        },
        warnings: draft.warnings.map((warning) => warning.code),
        meta: {
          regionSource: result.meta.regionSource,
          datasetId: result.meta.datasetId,
          regionVersion: result.meta.regionVersion,
          codeScheme: result.meta.codeScheme,
        },
      };
      setSaved(await call<SavedAddress>("/api/confirm", { method: "POST", body: JSON.stringify(payload) }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return <main className="wrap">
    <h1>addr-parse-kit 示例（粘贴 → 解析 → 修正 → 确认）</h1>
    <p className="hint">
      页面在浏览器里只使用 <code>addr-parse-kit</code> 的纯函数；解析走服务端 <code>addr-parse-kit/server</code>。
      区域数据由宿主注入，本包不内置任何区划数据。样例中的姓名、号码、楼盘全部为虚构数据。
    </p>

    <section>
      <h2>1. 粘贴文本</h2>
      <textarea rows={3} value={text} onChange={(event) => setText(event.target.value)} placeholder="收件人 电话 省市区街道 门牌房号" />
      <p>
        {SAMPLES.map((sample) => <button key={sample.label} type="button" onClick={() => setText(sample.text)}>{sample.label}</button>)}
      </p>
      <p className="options">
        <label><input type="checkbox" checked={extractRecipient} onChange={(event) => setExtractRecipient(event.target.checked)} />提取收件人</label>
        <label><input type="checkbox" checked={allowInferred} onChange={(event) => setAllowInferred(event.target.checked)} />允许推断缺失层级</label>
        <label>候选上限<input type="number" min={1} max={20} value={maxCandidates} onChange={(event) => setMaxCandidates(Number(event.target.value))} /></label>
        <button type="button" disabled={busy || !text.trim()} onClick={() => { void runParse(); }}>{busy ? "处理中…" : "解析"}</button>
      </p>
      {error !== "" && <p className="error" role="alert">{error}</p>}
    </section>

    {result !== null && <section>
      <h2>2. 候选与警告</h2>
      <p>
        状态 <code>{result.status}</code>，需人工复核 <code>{String(result.requiresReview)}</code>；
        数据 {result.meta.regionSource}/{result.meta.datasetId}/{result.meta.regionVersion}（{result.meta.codeScheme}），
        包版本 {result.meta.parserVersion}（引擎 {result.meta.sdkVersion}）。
      </p>
      <ul>{result.warnings.map((warning, index) => <li key={`${warning.code}-${index}`}>
        <code>{warning.code}</code> {warning.message}
      </li>)}</ul>
      <p className="hint">多条候选时不预选任何一条；置信度只用于排序，不作为“可直接落库”的依据。</p>
      <ol>{result.candidates.map((candidate) => <li key={candidate.candidateId}>
        <div>
          <code>{candidate.status}</code> · {formatAddress(candidate)} · 明细 <code>{candidate.detailedAddress || "（空）"}</code>
          {candidate.residualText !== "" && <> · 未消费文本 <code>{candidate.residualText}</code></>}
        </div>
        <ul>{candidate.warnings.map((warning) => <li key={warning.code}><code>{warning.code}</code> {warning.message}</li>)}</ul>
        <button type="button" onClick={() => adopt(candidate)}>用这条候选填充表单</button>
      </li>)}</ol>
    </section>}

    {draft !== null && <section>
      <h2>3. 手工修正</h2>
      {conflicts.length > 0 && <div className="conflict">
        <p>以下字段在宿主表单中已有非空值，默认只填空项、未覆盖：</p>
        <ul>{conflicts.map((item) => <li key={item}>{item}</li>)}</ul>
        <label><input type="checkbox" checked={overwrite} onChange={(event) => setOverwrite(event.target.checked)} />确认覆盖已有非空字段</label>
        <p className="hint">勾选后重新点击“用这条候选填充表单”才会生效。</p>
      </div>}
      <table className="grid">
        <tbody>
          <tr><td>姓名</td><td><input value={draft.recipient?.name ?? ""} onChange={(event) => edit((c) => applyRecipient(c, { name: event.target.value }))} /></td></tr>
          <tr><td>电话</td><td><input value={draft.recipient?.phone ?? ""} onChange={(event) => edit((c) => applyRecipient(c, { phone: event.target.value }))} /></td></tr>
          <tr><td>分机</td><td><input value={draft.recipient?.phoneExtension ?? ""} onChange={(event) => edit((c) => applyRecipient(c, { phoneExtension: event.target.value }))} /></td></tr>
          {draft.recipient?.maskedPhone !== undefined && <tr><td>掩码号码</td><td><code>{draft.recipient.maskedPhone}</code>（原样保留，不猜测缺失数字）</td></tr>}
          {(draft.recipient?.extraNames?.length || draft.recipient?.extraPhones?.length) ? <tr><td>其他收件信息</td><td>
            {(draft.recipient?.extraNames ?? []).map((name) => <code key={name}>{name} </code>)}
            {(draft.recipient?.extraPhones ?? []).map((phone) => <code key={phone}>{phone} </code>)}
          </td></tr> : null}
          <tr><td>详细地址</td><td><textarea rows={2} value={draft.detailedAddress} onChange={(event) => edit((c) => applyDetail(c, event.target.value))} /></td></tr>
          {SLOTS.map((slot) => {
            const value = selectionValue(draft, slot);
            const current = slotNode(draft, slot) ?? (slot === "city" && draft.regionGroup?.level === 2 ? draft.regionGroup : null);
            const items = lists[slot];
            const known = items.some((item) => item.code === value);
            return <tr key={slot}>
              <td>{SLOT_LABEL[slot]}{current?.match === "inferred" ? "（推断）" : ""}</td>
              <td>
                <select value={value} onChange={(event) => {
                  const option = event.target.value === "" ? null : items.find((item) => item.code === event.target.value) ?? null;
                  edit((c) => applyRegion(c, slot, option));
                }}>
                  <option value="">（未选择）</option>
                  {current !== null && !known && <option value={current.code}>{current.name}（不在候选列表）</option>}
                  {items.map((item) => <option key={item.code} value={item.code}>{item.name}{item.kind === "group" ? "（分组）" : ""}</option>)}
                </select>
                <code className="code">{value || "—"}</code>
                <button type="button" onClick={() => edit((c) => applyRegion(c, slot, null))}>清空本级及下级</button>
              </td>
            </tr>;
          })}
          {draft.regionGroup !== null && draft.regionGroup.level !== 2 && <tr><td>分组节点</td><td><code>{draft.regionGroup.code}</code> {draft.regionGroup.name}</td></tr>}
        </tbody>
      </table>
      <p className="options">
        <button type="button" onClick={() => { void checkPath(); }}>校验区域路径</button>
        <label><input type="radio" name="mode" checked={view === "withStreet"} onChange={() => setView("withStreet")} />输出到街道</label>
        <label><input type="radio" name="mode" checked={view === "withoutStreet"} onChange={() => setView("withoutStreet")} />不输出街道（并入详细地址）</label>
      </p>
      {pathCheck !== null && <p className={pathCheck.ok ? "ok" : "error"}>
        {pathCheck.ok ? "路径校验通过" : `路径校验未通过：${pathCheck.problems.map((p) => `${p.code} ${p.reason}`).join("；")}`}
      </p>}
      {manualEdits && <p className="hint">已手工修正；原始解析状态 {draft.status} 仅作为留痕，落库以确认结果为准。</p>}
    </section>}

    {draft !== null && preview !== null && <section>
      <h2>4. 重组预览</h2>
      <p>地址：<code>{preview.address}</code></p>
      <p>整行：<code>{preview.line}</code></p>
      {preview.folded !== null && <p className="hint">街道「{preview.folded.text}」已并入详细地址，未丢弃；切回“输出到街道”即可复原。</p>}
      {draft.residualText !== "" && <p className="hint">原文中仍有未被消费的文本：<code>{draft.residualText}</code></p>}
      {preview.integrity.length > 0 && <ul className="error">{preview.integrity.map((issue) => <li key={`${issue.field}-${issue.reason}`}>{issue.field}: {issue.reason}</li>)}</ul>}
    </section>}

    {draft !== null && <section>
      <h2>5. 确认并交给宿主保存</h2>
      <label><input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} />我已核对警告与上面的预览，确认这就是该订单的收货地址</label>
      <p className="options">
        <button type="button" disabled={busy || !reviewed || pathCheck?.ok === false} onClick={() => { void confirm(); }}>确认保存</button>
        <span className="hint">按钮只在勾选确认后启用；解析成功不等于用户确认。</span>
      </p>
      {saved !== null && <pre>{JSON.stringify(saved, null, 2)}</pre>}
    </section>}

    <footer className="hint">
      接口：POST /api/parse（收件原文只走请求体）、GET /api/regions?parentCode=（仅区域代码）、POST /api/validate、POST /api/confirm。
      示例服务端带认证/限流桩，生产宿主必须替换为自己的会话与配额，并把确认结果写入自己的库表（见 DATABASE.md）。
    </footer>
  </main>;
}
