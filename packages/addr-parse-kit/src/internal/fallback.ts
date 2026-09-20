import type { AddressCandidate, ParseWarning, Recipient } from "../types.js";
import { extendWithLabel, findLabeledNames, findMaskedPhones, findPhones, guessNameBefore, precededByNoteLabel, stripSpans, type Span } from "./text.js";

export function fallbackCandidate(raw: string, extractRecipient: boolean): AddressCandidate {
  const warnings: ParseWarning[] = [];
  const spans: Span[] = [];
  const recipient: Recipient = {};
  let hasRecipientInfo = false;

  if (extractRecipient) {
    const phones = findPhones(raw);
    if (phones.length) {
      recipient.phone = phones[0]!.digits;
      if (phones[0]!.extension) recipient.phoneExtension = phones[0]!.extension;
      spans.push(phones[0]!.span);
      hasRecipientInfo = true;
      if (phones.length > 1) {
        recipient.extraPhones = phones.slice(1).map((p) => p.digits);
        spans.push(...phones.slice(1).map((p) => p.span));
        warnings.push({ code: "MULTIPLE_PHONES", message: "文本中存在多个电话号码，除主号码外均保留在 extraPhones" });
      }
    }
    const masked = findMaskedPhones(raw);
    if (masked.length) {
      recipient.maskedPhone = masked[0]!.text;
      recipient.incompletePhone = true;
      warnings.push({ code: "PHONE_MASKED", message: "检测到掩码电话，原样保留且不猜测缺失数字" });
    }
    const labeled = findLabeledNames(raw);
    if (labeled.length) {
      recipient.name = labeled[0]!.name;
      spans.push(labeled[0]!.span);
      hasRecipientInfo = true;
      const extra = labeled.slice(1).flatMap((l) => [l.name, ...l.extra]);
      if (extra.length) {
        recipient.extraNames = extra;
        warnings.push({ code: "RECIPIENTS_AMBIGUOUS", message: "文本中存在多个疑似姓名" });
      }
    } else if (phones.length) {
      const guess = guessNameBefore(raw, phones[0]!.span.start);
      if (guess && !precededByNoteLabel(raw, guess.start)) {
        recipient.name = guess.text;
        spans.push(guess);
        hasRecipientInfo = true;
        warnings.push({ code: "RECIPIENTS_AMBIGUOUS", message: `姓名 "${guess.text}" 基于电话前紧邻中文的启发式提取（无标签），需人工确认` });
      }
    }
    const attributed = spans.map((s) => extendWithLabel(raw, s));
    const detail = stripSpans(raw, attributed).replace(/\s+/g, " ").trim();
    return buildCandidate(warnings, recipient, detail, hasRecipientInfo);
  }
  return buildCandidate([{ code: "RECIPIENT_SUPPRESSED", message: "已关闭收件人提取；未匹配区域时仅返回原文地址" }], {}, raw.trim(), false);
}

function buildCandidate(warnings: ParseWarning[], recipient: Recipient, detailedAddress: string, hasRecipientInfo: boolean): AddressCandidate {
  const candidate: AddressCandidate = {
    candidateId: "unmatched-fallback",
    rank: 1,
    confidence: 0,
    scoreReasons: [],
    status: "unmatched",
    requiresReview: true,
    warnings,
    mode: "withStreet",
    province: null,
    city: null,
    district: null,
    street: null,
    regionGroup: null,
    deepestLevel: 0,
    detailedAddress,
    residualText: "",
    recipient: hasRecipientInfo ? recipient : null,
  };
  return candidate;
}
