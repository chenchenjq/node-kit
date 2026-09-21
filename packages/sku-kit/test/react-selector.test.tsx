// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SkuSelector } from "../src/react/index.js";

describe("SkuSelector", () => {
  it("uses one radio group per dimension and replaces that dimension's choice", () => {
    const onSelectionChange = vi.fn();
    render(<SkuSelector options={[
      { dimensionId: "color", valueId: "red", label: "红" },
      { dimensionId: "color", valueId: "blue", label: "蓝" },
      { dimensionId: "size", valueId: "m", label: "M" },
    ]} selectedValueIds={["red", "m"]} onSelectionChange={onSelectionChange} />);
    const red = screen.getByRole("radio", { name: "红" });
    const blue = screen.getByRole("radio", { name: "蓝" });
    expect(red.getAttribute("name")).toBe("sku-dimension-color");
    expect((blue as HTMLInputElement).checked).toBe(false);
    fireEvent.click(blue);
    expect(onSelectionChange).toHaveBeenCalledWith(["m", "blue"]);
  });
});
