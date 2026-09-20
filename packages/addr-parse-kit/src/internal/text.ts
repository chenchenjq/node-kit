export interface Span {
  start: number;
  end: number;
  text: string;
}

export function makeSpan(raw: string, start: number, length: number): Span {
  return { start, end: start + length, text: raw.slice(start, start + length) };
}

/** 在 raw 中从 from 起定位 needle；needle 内部允许夹杂空白字符（匹配真实原文区间）。 */
export function findSpan(raw: string, needle: string, from = 0): Span | null {
  if (!needle) return null;
  const exact = raw.indexOf(needle, from);
  if (exact >= 0) return makeSpan(raw, exact, needle.length);
  const chars = [...needle];
  outer: for (let i = from; i < raw.length; i++) {
    let p = i;
    for (const ch of chars) {
      while (p < raw.length && /\s/.test(raw[p]!)) p++;
      if (raw[p] !== ch) continue outer;
      p++;
    }
    return makeSpan(raw, i, p - i);
  }
  return null;
}

export function stripSpans(raw: string, spans: readonly Span[]): string {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  let out = "";
  let pos = 0;
  for (const s of sorted) {
    if (s.start < pos) continue;
    out += raw.slice(pos, s.start);
    pos = s.end;
  }
  return out + raw.slice(pos);
}

const LABEL_BEFORE = /(?:联系电话|收件人|联系人|收货人|姓名|电话|手机|联系方式|地址|邮编|邮政编码)\s*[:：]?\s*$/;

export function extendWithLabel(raw: string, span: Span): Span {
  const head = raw.slice(0, span.start);
  const m = LABEL_BEFORE.exec(head);
  if (!m) return span;
  return makeSpan(raw, span.start - m[0].length, m[0].length + span.text.length);
}

const EXT_TAIL = String.raw`(?:[\s-]*(?:转|分机|ext\.?|x)[\s-]*\d{1,6})?`;

/**
 * 前后都不许紧邻数字：否则 19 位订单号、18 位身份证号里的连续片段会被当成电话（且只保留 11 位）。
 */
export const PHONE_SPAN_RE = new RegExp(
  String.raw`(?<!\d)(?:\+?86[-\s]?)?(?:1[3-9]\d[\s-]?\d{4}[\s-]?\d{4}|0\d{2,3}[-\s]?\d{7,8})${EXT_TAIL}(?!\d)`,
  "gi",
);
const PHONE_EXT_RE = /(?:[\s-]*(?:转|分机|ext\.?|x)[\s-]*\d{1,6})$/i;
export const MASKED_PHONE_RE = /1\d{2}\*{3,4}\d{4}/g;

export interface PhoneMatch {
  span: Span;
  digits: string;
  extension?: string;
}

export function findPhones(raw: string): PhoneMatch[] {
  const out: PhoneMatch[] = [];
  for (const m of raw.matchAll(PHONE_SPAN_RE)) {
    if (m.index === undefined || !m[0]) continue;
    const extMatch = PHONE_EXT_RE.exec(m[0]);
    const body = extMatch ? m[0].slice(0, extMatch.index) : m[0];
    const digits = body.replace(/\D+/g, "");
    const extDigits = /(\d{1,6})$/.exec(extMatch?.[0] ?? "")?.[1];
    const match: PhoneMatch = { span: makeSpan(raw, m.index, m[0].length), digits };
    if (extDigits) match.extension = extDigits;
    out.push(match);
  }
  return out;
}

export function findMaskedPhones(raw: string): Span[] {
  const out: Span[] = [];
  for (const m of raw.matchAll(MASKED_PHONE_RE)) {
    if (m.index === undefined || !m[0]) continue;
    out.push(makeSpan(raw, m.index, m[0].length));
  }
  return out;
}

export const LABELED_NAME_RE = /(?:收件人|联系人|收货人|姓名|寄件人|收)\s*[:：]?\s*([\u4e00-\u9fa5·]{2,6})(?:\s*[\/、,，&和]\s*([\u4e00-\u9fa5·]{2,6}))?/g;

export function findLabeledNames(raw: string): { span: Span; name: string; extra: string[] }[] {
  const out: { span: Span; name: string; extra: string[] }[] = [];
  for (const m of raw.matchAll(LABELED_NAME_RE)) {
    if (m.index === undefined || !m[1]) continue;
    const name = m[1];
    const extra = m[2] ? [m[2]] : [];
    const start = m.index + m[0].indexOf(name);
    out.push({ span: makeSpan(raw, start, name.length), name, extra });
  }
  return out;
}

const NOTE_LABEL_NEAR_RE = /(?:备注|说明|留言|注意|提示|附言)[^。；;]{0,12}$/;

/** 名称片段前若紧跟「备注：…」这类说明句，说明它是备注内容而不是收件人。 */
export function precededByNoteLabel(raw: string, index: number): boolean {
  return NOTE_LABEL_NEAR_RE.test(raw.slice(Math.max(0, index - 24), index));
}

/** 无标签兜底：电话前紧邻的 2–4 个汉字最可能是姓名。 */
export function guessNameBefore(raw: string, index: number): Span | null {
  const head = raw.slice(0, index);
  const m = /([\u4e00-\u9fa5]{2,4})[，,;；]?\s*$/.exec(head);
  if (!m?.[1] || m.index === undefined) return null;
  return makeSpan(raw, m.index, m[1].length);
}

export function normalizeForCompare(s: string): string {
  return s.replace(/[\s()（）.,、;；:：\-_·，。]/g, "");
}
