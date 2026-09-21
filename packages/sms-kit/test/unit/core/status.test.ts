import { describe, expect, it } from "vitest";

import {
  SmsKitError,
  assertAcceptanceTransition,
  assertDeliveryTransition,
} from "../../../src/core/index.js";

describe("delivery state transitions", () => {
  it("keeps a delivered message terminal", () => {
    expect(() => assertDeliveryTransition("delivered", "waiting")).toThrowError(
      new SmsKitError("CONCURRENT_MODIFICATION", "delivery status cannot move backward"),
    );
  });

  it("allows direct receipts to set a final delivery status", () => {
    expect(() => assertDeliveryTransition("not_applicable", "delivered")).not.toThrow();
    expect(() => assertDeliveryTransition("not_applicable", "failed")).not.toThrow();
  });
});

describe("acceptance state transitions", () => {
  it("allows unknown to rejected only for the original dispatch response", () => {
    expect(() => assertAcceptanceTransition("unknown", "rejected", "query-no-record")).toThrowError(
      /authoritative/,
    );
    expect(() => assertAcceptanceTransition("unknown", "rejected", "same-dispatch-response")).not.toThrow();
  });

  it("requires positive provider evidence when unknown acceptance becomes accepted", () => {
    expect(() => assertAcceptanceTransition("unknown", "accepted", "query-no-record")).toThrowError(
      /authoritative/,
    );
    expect(() => assertAcceptanceTransition("unknown", "accepted", "positive-provider-evidence")).not.toThrow();
  });
});
