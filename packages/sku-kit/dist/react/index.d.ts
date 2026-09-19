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
export declare const SkuSelector: ({ options, selectedValueIds, onSelectionChange }: SkuSelectorProps) => import("react").JSX.Element;
export interface SkuEditorProps {
    value: ManagementConfiguration;
    onSave(): void;
    busy?: boolean;
}
export declare const SkuEditor: ({ value, onSave, busy }: SkuEditorProps) => import("react").JSX.Element;
