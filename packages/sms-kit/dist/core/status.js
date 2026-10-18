import { SmsKitError } from "./errors.js";
const deliveryTransitions = {
    not_applicable: ["waiting", "delivered", "failed", "unknown_final"],
    waiting: ["delivered", "failed", "unknown_final"],
    delivered: [],
    failed: [],
    unknown_final: [],
};
export function assertAcceptanceTransition(from, to, evidence) {
    const initial = from === "pending" && ["accepted", "rejected", "unknown"].includes(to);
    const recoveredAccepted = from === "unknown" && to === "accepted" && evidence !== "query-no-record";
    const lateRejected = from === "unknown" && to === "rejected" && evidence === "same-dispatch-response";
    if (!(initial || recoveredAccepted || lateRejected)) {
        throw new SmsKitError("CONCURRENT_MODIFICATION", "authoritative acceptance transition required");
    }
}
export function assertDeliveryTransition(from, to) {
    if (!deliveryTransitions[from].includes(to)) {
        throw new SmsKitError("CONCURRENT_MODIFICATION", "delivery status cannot move backward");
    }
}
