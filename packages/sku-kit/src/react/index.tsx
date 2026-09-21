"use client";

import type { ChangeEvent } from "react";
import type { ManagementConfiguration } from "../server/contracts.js";

export interface SkuSelectorOption {
  dimensionId: string;
  valueId: string;
  label: string;
  disabled?: boolean;
}

export interface SkuSelectorProps {
  options: readonly SkuSelectorOption[];
  selectedValueIds: readonly string[];
  onSelectionChange(valueIds: readonly string[]): void;
}

export const SkuSelector = ({ options, selectedValueIds, onSelectionChange }: SkuSelectorProps) => {
  const dimensions = [...new Set(options.map((option) => option.dimensionId))];
  const change = (option: SkuSelectorOption, event: ChangeEvent<HTMLInputElement>) => {
    const withoutDimension = selectedValueIds.filter((valueId) => !options.some((candidate) => candidate.dimensionId === option.dimensionId && candidate.valueId === valueId));
    onSelectionChange(event.target.checked ? [...withoutDimension, option.valueId] : withoutDimension);
  };
  return (
    <section aria-label="销售规格">
      {dimensions.map((dimensionId) => {
        const values = options.filter((option) => option.dimensionId === dimensionId);
        return <fieldset key={dimensionId} aria-label={`规格 ${dimensionId}`}>
          <legend>选择规格</legend>
          {values.map((option) => <label key={option.valueId}>
            <input type="radio" name={`sku-dimension-${dimensionId}`} checked={selectedValueIds.includes(option.valueId)} disabled={option.disabled ?? false} onChange={(event) => change(option, event)} />
            {option.label}
          </label>)}
        </fieldset>;
      })}
    </section>
  );
};

export interface SkuEditorProps {
  value: ManagementConfiguration;
  onSave(): void;
  busy?: boolean;
}

export const SkuEditor = ({ value, onSave, busy = false }: SkuEditorProps) => (
  <section aria-label="SKU 配置">
    <h2>SKU 配置</h2>
    <p>结构版本：{value.structureVersion}</p>
    <table>
      <thead><tr><th>编码</th><th>状态</th></tr></thead>
      <tbody>{value.skus.map((sku) => <tr key={sku.id}><td>{sku.skuCode}</td><td>{sku.status}</td></tr>)}</tbody>
    </table>
    <button type="button" onClick={onSave} disabled={busy}>保存配置</button>
  </section>
);
