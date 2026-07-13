import { describe, expect, it } from "vitest";
import { decideDurableSendTurnCommand } from "../../../src/lib/provider/orchestration-decider.js";
import { makeSessionCreatedEvent } from "../../helpers/persistence-factories.js";

describe("orchestration decider", () => {
	it("plans send_turn as durable events, receipt, read-model meta, and outbox", () => {
		const event = makeSessionCreatedEvent("session-1");

		const plan = decideDurableSendTurnCommand({
			commandId: "cmd-1",
			projectKey: "project-1",
			sessionId: "session-1",
			providerId: "claude",
			fingerprintHash: "sha256:abc",
			nowMs: 1000,
			requestSequence: 1,
			payloadJson: '{"prompt":"hello"}',
			events: [event],
		});

		expect(plan.events).toEqual([event]);
		expect(plan.receipt).toMatchObject({
			commandId: "cmd-1",
			commandType: "send_turn",
			projectKey: "project-1",
			sessionId: "session-1",
			status: "side_effect_requested",
			fingerprintHash: "sha256:abc",
			fingerprintVersion: 2,
			acceptedSequence: 1,
			sideEffectSequence: 1,
			createdAt: 1000,
			updatedAt: 1000,
		});
		expect(plan.outboxRequests).toEqual([
			{
				requestSequence: 1,
				commandId: "cmd-1",
				projectKey: "project-1",
				sessionId: "session-1",
				providerId: "claude",
				effectType: "send_turn",
				payloadJson: '{"prompt":"hello"}',
			},
		]);
		expect(plan.readModelRows).toEqual(["provider_command_meta"]);
	});
});
