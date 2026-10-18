export type AcceptanceStatus = "pending" | "accepted" | "rejected" | "unknown";
export type AcceptanceEvidence = "same-dispatch-response" | "positive-provider-evidence" | "query-no-record";
export type DeliveryStatus = "not_applicable" | "waiting" | "delivered" | "failed" | "unknown_final";
export declare function assertAcceptanceTransition(from: AcceptanceStatus, to: AcceptanceStatus, evidence: AcceptanceEvidence): void;
export declare function assertDeliveryTransition(from: DeliveryStatus, to: DeliveryStatus): void;
