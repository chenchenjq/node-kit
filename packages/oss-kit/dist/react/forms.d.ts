import type { AccessLink, ConnectionTestResult, CredentialUpdate, FileReference, StorageInput, StorageSummary, Strategy, StrategyInput } from "../types.js";
/** Browser-safe representation of the server's admin test request. */
export interface StorageTestInput {
    input: StorageInput;
    credentials?: CredentialUpdate;
    storageConfigId?: string;
    prefix: string;
}
export interface StorageManagerProps {
    list: () => Promise<StorageSummary[]>;
    save: (input: StorageInput, credentials?: CredentialUpdate, id?: string) => Promise<void>;
    test: (request: StorageTestInput) => Promise<ConnectionTestResult>;
    setDefault: (id: string) => Promise<void>;
    setEnabled: (id: string, enabled: boolean) => Promise<void>;
    className?: string;
}
export interface StrategyEditorProps {
    listStorage: () => Promise<StorageSummary[]>;
    listStrategies: () => Promise<Strategy[]>;
    save: (input: StrategyInput) => Promise<void>;
    preview: (input: StrategyInput, originalName: string) => Promise<string>;
    className?: string;
}
export interface UploadExampleProps {
    listStrategies: () => Promise<Strategy[]>;
    upload: (code: string, file: File) => Promise<FileReference>;
    getLink: (reference: FileReference) => Promise<AccessLink>;
    className?: string;
}
export declare function StorageManager({ list, save, test, setDefault, setEnabled, className, }: StorageManagerProps): import("react").JSX.Element;
export declare function StrategyEditor({ listStorage, listStrategies, save, preview, className, }: StrategyEditorProps): import("react").JSX.Element;
export declare function UploadExample({ listStrategies, upload, getLink, className, }: UploadExampleProps): import("react").JSX.Element;
