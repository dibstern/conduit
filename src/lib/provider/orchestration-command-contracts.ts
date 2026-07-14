export const DURABLE_COMMAND_RECEIPT_STATUSES = [
	"accepted",
	"rejected",
	"side_effect_requested",
	"side_effect_completed",
	"side_effect_failed",
] as const;

export type DurableCommandReceiptStatus =
	(typeof DURABLE_COMMAND_RECEIPT_STATUSES)[number];

export const DURABLE_COMMAND_TRANSACTION_ROWS = [
	"events",
	"command_receipts",
	"provider_command_sessions",
	"provider_command_turns",
	"provider_command_interactions",
	"provider_command_tombstones",
	"provider_command_outbox",
	"provider_command_meta",
] as const;

export type DurableCommandTransactionRow =
	(typeof DURABLE_COMMAND_TRANSACTION_ROWS)[number];

export const DURABLE_COMMAND_FINGERPRINT_FIELDS = [
	"commandType",
	"sessionId",
	"providerId",
	"providerInstanceId",
	"runtimeMode",
	"interactionMode",
	"workspaceRoot",
	"promptText",
	"imageDigests",
	"effectiveModel",
	"providerOptions",
	"materialDefaults",
] as const;

export type DurableCommandFingerprintField =
	(typeof DURABLE_COMMAND_FINGERPRINT_FIELDS)[number];

/**
 * Effective-dispatch fingerprint scheme version. Bumped from 1 to 2 when the
 * canonicalizer began folding the model provider id into the effective model
 * and representing the Claude active-session model fallback. Pre-existing
 * receipts were written under v1, so their stored fingerprint hash differs from
 * a v2 recomputation of the same command.
 */
export const DURABLE_COMMAND_FINGERPRINT_VERSION = 2;

export interface DurableCommandFingerprint {
	readonly version: typeof DURABLE_COMMAND_FINGERPRINT_VERSION;
	readonly fields: Readonly<Record<DurableCommandFingerprintField, unknown>>;
}

export interface DurableCommandReceiptWrite {
	readonly commandId: string;
	readonly commandType: string;
	readonly projectKey: string;
	readonly sessionId: string;
	readonly status: DurableCommandReceiptStatus;
	readonly fingerprintHash: string;
	readonly fingerprintVersion: typeof DURABLE_COMMAND_FINGERPRINT_VERSION;
	readonly acceptedSequence?: number;
	readonly sideEffectSequence?: number;
	readonly resultSequence?: number;
	readonly errorCode?: string;
	readonly createdAt: number;
	readonly updatedAt: number;
}

export interface DurableCommandOutboxRequest {
	readonly requestSequence: number;
	readonly commandId: string;
	readonly projectKey: string;
	readonly sessionId: string;
	readonly providerId: string;
	readonly effectType: "send_turn" | "interrupt_turn";
	readonly payloadJson: string;
}

export interface DurableCommandCommitPlan {
	readonly receipt: DurableCommandReceiptWrite;
	readonly outboxRequests: readonly DurableCommandOutboxRequest[];
	readonly readModelRows: readonly DurableCommandTransactionRow[];
}
