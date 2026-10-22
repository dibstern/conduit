import { Schema } from "effect";
import { AccountSchema } from "../contracts/account.js";
import { ProviderStopSnapshotSchema } from "../contracts/stored-event.js";
import { ProviderPermissionUpdateSchema } from "../shared-types.js";

export const STOP_ABORT_WAIT_MS = 30_000;

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
	readonly effectType: "send_turn" | ProviderControlPayload["type"];
	readonly providerProcessId?: string;
	readonly payloadJson: string;
}

export interface DurableCommandCommitPlan {
	// The bound repository supplies provenance when turning a plan into writes.
	readonly receipt: Omit<DurableCommandReceiptWrite, "projectKey">;
	readonly outboxRequests: readonly Omit<
		DurableCommandOutboxRequest,
		"projectKey"
	>[];
	readonly readModelRows: readonly DurableCommandTransactionRow[];
}

const controlTarget = {
	sessionId: Schema.String,
	providerProcessId: Schema.String,
};

/** Persisted control data; runtime handles and run reservations are absent. */
export const ProviderControlPayloadSchema = Schema.Union([
	Schema.Struct({
		...controlTarget,
		type: Schema.Literal("interrupt_turn"),
		turnIds: Schema.optionalKey(Schema.Array(Schema.String)),
		stop: Schema.optionalKey(ProviderStopSnapshotSchema),
	}),
	Schema.Struct({
		...controlTarget,
		type: Schema.Literal("resolve_permission"),
		requestId: Schema.String,
		nativeRequestId: Schema.optionalKey(Schema.String),
		decision: Schema.Literals(["once", "always", "reject"]),
		response: Schema.optionalKey(
			Schema.Struct({
				decision: Schema.Literals(["once", "always", "reject"]),
				permissionUpdates: Schema.optionalKey(
					Schema.Array(ProviderPermissionUpdateSchema),
				),
			}),
		),
	}),
	Schema.Struct({
		...controlTarget,
		type: Schema.Literal("resolve_question"),
		requestId: Schema.String,
		nativeRequestId: Schema.optionalKey(Schema.String),
		answers: Schema.Record(Schema.String, Schema.Unknown),
		operation: Schema.optionalKey(Schema.Literals(["reply", "reject"])),
	}),
	Schema.Struct({
		...controlTarget,
		type: Schema.Literal("end_session"),
		stop: Schema.optionalKey(ProviderStopSnapshotSchema),
		retireProcess: Schema.optionalKey(Schema.Literal(true)),
		retireRunIds: Schema.optionalKey(Schema.Array(Schema.String)),
		targetProviderId: Schema.optionalKey(Schema.String),
		account: Schema.optionalKey(AccountSchema),
		unbind: Schema.optionalKey(Schema.Boolean),
	}),
]);
export type ProviderControlPayload = typeof ProviderControlPayloadSchema.Type;
