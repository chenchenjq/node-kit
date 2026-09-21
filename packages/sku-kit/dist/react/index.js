"use client";
import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
export const SkuSelector = ({ options, selectedValueIds, onSelectionChange }) => {
    const dimensions = [...new Set(options.map((option) => option.dimensionId))];
    const change = (option, event) => {
        const withoutDimension = selectedValueIds.filter((valueId) => !options.some((candidate) => candidate.dimensionId === option.dimensionId && candidate.valueId === valueId));
        onSelectionChange(event.target.checked ? [...withoutDimension, option.valueId] : withoutDimension);
    };
    return (_jsx("section", { "aria-label": "\u9500\u552E\u89C4\u683C", children: dimensions.map((dimensionId) => {
            const values = options.filter((option) => option.dimensionId === dimensionId);
            return _jsxs("fieldset", { "aria-label": `规格 ${dimensionId}`, children: [_jsx("legend", { children: "\u9009\u62E9\u89C4\u683C" }), values.map((option) => _jsxs("label", { children: [_jsx("input", { type: "radio", name: `sku-dimension-${dimensionId}`, checked: selectedValueIds.includes(option.valueId), disabled: option.disabled ?? false, onChange: (event) => change(option, event) }), option.label] }, option.valueId))] }, dimensionId);
        }) }));
};
export const SkuEditor = ({ value, onSave, busy = false }) => (_jsxs("section", { "aria-label": "SKU \u914D\u7F6E", children: [_jsx("h2", { children: "SKU \u914D\u7F6E" }), _jsxs("p", { children: ["\u7ED3\u6784\u7248\u672C\uFF1A", value.structureVersion] }), _jsxs("table", { children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "\u7F16\u7801" }), _jsx("th", { children: "\u72B6\u6001" })] }) }), _jsx("tbody", { children: value.skus.map((sku) => _jsxs("tr", { children: [_jsx("td", { children: sku.skuCode }), _jsx("td", { children: sku.status })] }, sku.id)) })] }), _jsx("button", { type: "button", onClick: onSave, disabled: busy, children: "\u4FDD\u5B58\u914D\u7F6E" })] }));
