import type { CanonicalEvent } from "../persistence/events.js";
import type { DurableCommandCommitInput } from "./orchestration-command-commit.js";
import { DURABLE_COMMAND_FINGERPRINT_VERSION } from "./orchestration-command-contracts.js";

export interface DurableSendTurnCommandDecisionInput {
	readonly commandId: string;
	readonly projectKey: string;
	readonly sessionId: string;
	readonly providerId: string;
	readonly fingerprintHash: string;
	readonly nowMs: number;
	readonly requestSequence: number;
	readonly payloadJson: string;
	readonly events: readonly CanonicalEvent[];
}

export function decideDurableSendTurnCommand(
	input: DurableSendTurnCommandDecisionInput,
): DurableCommandCommitInput {
	return {
		events: input.events,
		receipt: {
			commandId: input.commandId,
			commandType: "send_turn",
			projectKey: input.projectKey,
			sessionId: input.sessionId,
			status: "side_effect_requested",
			fingerprintHash: input.fingerprintHash,
			fingerprintVersion: DURABLE_COMMAND_FINGERPRINT_VERSION,
			acceptedSequence: input.requestSequence,
			sideEffectSequence: input.requestSequence,
			createdAt: input.nowMs,
			updatedAt: input.nowMs,
		},
		outboxRequests: [
			{
				requestSequence: input.requestSequence,
				commandId: input.commandId,
				projectKey: input.projectKey,
				sessionId: input.sessionId,
				providerId: input.providerId,
				effectType: "send_turn",
				payloadJson: input.payloadJson,
			},
		],
		readModelRows: ["provider_command_meta"],
	};
}
