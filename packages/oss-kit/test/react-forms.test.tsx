// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  StorageManager,
  StrategyEditor,
  UploadExample,
} from "../src/react/index.js";

afterEach(cleanup);

const storage = {
  id: "s1",
  name: "Primary",
  region: "oss-cn-hangzhou",
  bucket: "media",
  endpoint: "oss-cn-hangzhou.aliyuncs.com",
  access: "private" as const,
  publicDomain: null,
  enabled: true,
  isDefault: true,
  used: false,
  revision: 1,
};
const strategy = {
  code: "images",
  name: "Images",
  description: "",
  storageConfigId: null,
  prefix: "assets",
  dateDirectory: "year-month-day" as const,
  naming: "uuid" as const,
  allowedExtensions: ["png"],
  allowedMimeTypes: ["image/png"],
  maxSizeBytes: 1024,
  enabled: true,
  used: false,
};

describe("oss-kit React references", () => {
  it("edits storage without returning or replacing an empty secret and renders each test step", async () => {
    const save = vi.fn(async () => {});
    const test = vi.fn(async () => ({
      objectKey: "oss-kit-test/a",
      upload: { status: "passed" as const },
      read: {
        status: "failed" as const,
        error: { code: "OSS_ERROR" as const, message: "read denied" },
      },
      delete: { status: "skipped" as const },
      cleanupRequired: true,
    }));
    const user = userEvent.setup();
    render(
      <StorageManager
        list={vi.fn(async () => [storage])}
        save={save}
        test={test}
        setDefault={vi.fn(async () => {})}
        setEnabled={vi.fn(async () => {})}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText("Region")).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("Bucket")).toHaveProperty("disabled", true);
    expect(
      (screen.getByLabelText("Access key secret") as HTMLInputElement).value,
    ).toBe("");
    await user.click(screen.getByRole("button", { name: "Save storage" }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Primary" }),
        undefined,
        "s1",
      ),
    );
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText(/read: failed/)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "Cleanup could not be confirmed",
    );
    expect(test).toHaveBeenCalledWith(
      expect.objectContaining({
        storageConfigId: "s1",
        prefix: "oss-kit-test",
        input: expect.objectContaining({ name: "Primary" }),
      }),
    );
  });

  it("synchronizes an edited configuration after it is disabled", async () => {
    let records = [storage];
    const setEnabled = vi.fn(async (id: string, enabled: boolean) => {
      records = records.map((record) =>
        record.id === id ? { ...record, enabled } : record,
      );
    });
    const user = userEvent.setup();
    render(
      <StorageManager
        list={vi.fn(async () => records)}
        save={vi.fn(async () => {})}
        test={vi.fn(async () => ({
          objectKey: "x",
          upload: { status: "passed" as const },
          read: { status: "passed" as const },
          delete: { status: "passed" as const },
          cleanupRequired: false,
        }))}
        setDefault={vi.fn(async () => {})}
        setEnabled={setEnabled}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Disable" }));
    await waitFor(() => expect(setEnabled).toHaveBeenCalledWith("s1", false));
    expect(screen.getByRole("checkbox", { name: "Enabled" })).toHaveProperty(
      "checked",
      false,
    );
  });

  it("allows a secret-only edit, locks its in-flight draft, then clears credential and STS-reset state for a safe repeat save", async () => {
    let finish!: () => void;
    const save = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <StorageManager
        list={vi.fn(async () => [storage])}
        save={save}
        test={vi.fn(async () => ({
          objectKey: "x",
          upload: { status: "passed" as const },
          read: { status: "passed" as const },
          delete: { status: "passed" as const },
          cleanupRequired: false,
        }))}
        setDefault={vi.fn(async () => {})}
        setEnabled={vi.fn(async () => {})}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.type(screen.getByLabelText("Access key secret"), "next-secret");
    await user.click(
      screen.getByRole("checkbox", { name: "Clear saved STS token" }),
    );
    await user.click(screen.getByRole("button", { name: "Save storage" }));
    expect(
      screen.getByRole("button", { name: "New storage configuration" }),
    ).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Edit" })).toHaveProperty(
      "disabled",
      true,
    );
    finish();
    await screen.findByText("Storage configuration saved.");
    expect(save.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        accessKeyId: "",
        accessKeySecret: "next-secret",
        clearStsToken: true,
      }),
    );
    expect(
      screen.getByRole("checkbox", { name: "Clear saved STS token" }),
    ).toHaveProperty("checked", false);
    await user.click(screen.getByRole("button", { name: "Save storage" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1]?.[1]).toBeUndefined();
  });

  it("uses the host preview callback and keeps a strategy code immutable while editing", async () => {
    const preview = vi.fn(async () => "assets/2026/09/key.png");
    const user = userEvent.setup();
    render(
      <StrategyEditor
        listStorage={vi.fn(async () => [storage])}
        listStrategies={vi.fn(async () => [strategy])}
        save={vi.fn(async () => {})}
        preview={preview}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText("Code")).toHaveProperty("disabled", true);
    await user.clear(screen.getByLabelText("Original file name for preview"));
    await user.type(
      screen.getByLabelText("Original file name for preview"),
      "photo.png",
    );
    await user.click(
      screen.getByRole("button", { name: "Preview object key" }),
    );
    await waitFor(() =>
      expect(preview).toHaveBeenCalledWith(
        expect.objectContaining({ code: "images" }),
        "photo.png",
      ),
    );
    expect(await screen.findByText("assets/2026/09/key.png")).toBeTruthy();
  });

  it("prevents changing a strategy draft while its server preview is pending", async () => {
    let finish!: (key: string) => void;
    const preview = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const user = userEvent.setup();
    render(
      <StrategyEditor
        listStorage={vi.fn(async () => [storage])}
        listStrategies={vi.fn(async () => [strategy])}
        save={vi.fn(async () => {})}
        preview={preview}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.click(
      screen.getByRole("button", { name: "Preview object key" }),
    );
    expect(screen.getByRole("button", { name: "New strategy" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("button", { name: "Edit" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByLabelText("Name").matches(":disabled")).toBe(true);
    finish("assets/locked.png");
    expect(await screen.findByText("assets/locked.png")).toBeTruthy();
  });

  it("keeps multiline policy and numeric drafts editable, then normalizes them only on save", async () => {
    const save = vi.fn(async () => {});
    const user = userEvent.setup();
    render(
      <StrategyEditor
        listStorage={vi.fn(async () => [storage])}
        listStrategies={vi.fn(async () => [])}
        save={save}
        preview={vi.fn(async () => "unused")}
      />,
    );
    await user.type(screen.getByLabelText("Code"), "documents");
    await user.type(screen.getByLabelText("Name"), "Documents");
    await user.type(screen.getByLabelText("Allowed extensions"), "pdf\ndocx");
    await user.type(
      screen.getByLabelText("Allowed MIME types"),
      "application/pdf\napplication/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    const maxSize = screen.getByLabelText("Max size in bytes");
    await user.clear(maxSize);
    await user.type(maxSize, "2048");
    expect(
      (screen.getByLabelText("Allowed extensions") as HTMLTextAreaElement)
        .value,
    ).toBe("pdf\ndocx");
    expect((maxSize as HTMLInputElement).value).toBe("2048");
    await user.click(screen.getByRole("button", { name: "Save strategy" }));
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedExtensions: ["pdf", "docx"],
        maxSizeBytes: 2048,
      }),
    );
  });

  it("waits for trusted-host upload success before requesting and displaying an access link", async () => {
    const upload = vi.fn(async () => ({
      storageConfigId: "s1",
      strategyCode: "images",
      objectKey: "assets/a.png",
      originalName: "a.png",
      size: 1,
      mimeType: "image/png",
    }));
    const getLink = vi.fn(async () => ({
      url: "https://host.example/files/a",
      expiresAt: "2026-09-17T00:05:00.000Z",
      access: "private" as const,
    }));
    const user = userEvent.setup();
    render(
      <UploadExample
        listStrategies={vi.fn(async () => [strategy])}
        upload={upload}
        getLink={getLink}
      />,
    );
    await screen.findByRole("option", { name: "Images" });
    await user.selectOptions(screen.getByLabelText("Strategy"), "images");
    const file = new File(["x"], "a.png", { type: "image/png" });
    await user.upload(screen.getByLabelText("File"), file);
    expect(getLink).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Upload file" }));
    await screen.findByText("Uploaded:", { exact: false });
    await user.click(screen.getByRole("button", { name: "Get access link" }));
    expect(getLink).toHaveBeenCalledWith(
      expect.objectContaining({ objectKey: "assets/a.png" }),
    );
    expect(
      (
        await screen.findByRole("link", { name: "Open transient access link" })
      ).getAttribute("href"),
    ).toBe("https://host.example/files/a");
  });
});
