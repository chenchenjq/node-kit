"use client";

import { useRef } from "react";
import {
  StorageManager,
  StrategyEditor,
  UploadExample,
  type StorageTestInput,
} from "oss-kit/react";
import type {
  AccessLink,
  ConnectionTestResult,
  CredentialUpdate,
  FileReference,
  StorageInput,
  StorageSummary,
  Strategy,
  StrategyInput,
} from "oss-kit";

type ApiError = { error?: { message?: string } };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: "no-store", ...init });
  const body = (await response.json().catch(() => ({}))) as ApiError & T;
  if (!response.ok)
    throw new Error(
      body.error?.message || "The request could not be completed.",
    );
  return body;
}

function json(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function referenceKey(reference: FileReference): string {
  return `${reference.storageConfigId}:${reference.strategyCode}:${reference.objectKey}`;
}

export default function Page() {
  const fileIds = useRef(new Map<string, string>());
  const listStorage = () =>
    request<StorageSummary[]>("/api/oss-kit/admin/storage");
  const saveStorage = (
    input: StorageInput,
    credentials?: CredentialUpdate,
    id?: string,
  ) =>
    request<void>(
      "/api/oss-kit/admin/storage",
      json({
        ...(id ? { id } : {}),
        input,
        ...(credentials ? { credentials } : {}),
      }),
    );
  const testStorage = (input: StorageTestInput) =>
    request<ConnectionTestResult>("/api/oss-kit/admin/test", json(input));
  const listStrategies = () => request<Strategy[]>("/api/oss-kit/strategies");

  return (
    <main
      style={{
        display: "grid",
        gap: "1.5rem",
        padding: "1.5rem",
        justifyItems: "start",
      }}
    >
      <StorageManager
        list={listStorage}
        save={saveStorage}
        test={testStorage}
        setDefault={(id) =>
          request<void>("/api/oss-kit/admin/default", json({ id }))
        }
        setEnabled={(id, enabled) =>
          request<void>("/api/oss-kit/admin/enabled", json({ id, enabled }))
        }
      />
      <StrategyEditor
        listStorage={listStorage}
        listStrategies={() =>
          request<Strategy[]>("/api/oss-kit/admin/strategies")
        }
        save={(input: StrategyInput) =>
          request<void>("/api/oss-kit/admin/strategies", json(input))
        }
        preview={(input: StrategyInput, originalName: string) =>
          request<{ objectKey: string }>(
            "/api/oss-kit/admin/preview",
            json({ input, originalName }),
          ).then((result) => result.objectKey)
        }
      />
      <UploadExample
        listStrategies={listStrategies}
        upload={async (code, file) => {
          const result = await request<{
            fileId: string;
            reference: FileReference;
          }>("/api/oss-kit/upload", {
            method: "POST",
            headers: {
              "x-oss-strategy": code,
              "x-oss-filename": encodeURIComponent(file.name),
              "Content-Type": file.type || "application/octet-stream",
            },
            body: file,
          });
          fileIds.current.set(referenceKey(result.reference), result.fileId);
          return result.reference;
        }}
        getLink={async (reference): Promise<AccessLink> => {
          const id = fileIds.current.get(referenceKey(reference));
          if (!id)
            throw new Error(
              "This file was not uploaded by this page. Request access from its owning record.",
            );
          return request<AccessLink>(
            `/api/oss-kit/files/${encodeURIComponent(id)}/link`,
          );
        }}
      />
    </main>
  );
}
