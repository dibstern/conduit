import { describe, expect, it } from "vitest";
import {
	effectiveDispatchFingerprint,
	fingerprintHash,
} from "../../../src/lib/provider/orchestration-command-fingerprint.js";
import type { SendTurnCommand } from "../../../src/lib/provider/orchestration-engine.js";
import { createMockEventSink } from "../../helpers/mock-sdk.js";

function sendTurn(
	overrides: Omit<Partial<SendTurnCommand>, "input"> & {
		input?: Partial<SendTurnCommand["input"]>;
	} = {},
): SendTurnCommand {
	const { input: inputOverrides, ...commandOverrides } = overrides;
	return {
		type: "send_turn",
		commandId: "cmd-1",
		providerId: "claude",
		...commandOverrides,
		input: {
			sessionId: "session-1",
			turnId: "turn-1",
			prompt: "hello",
			history: [],
			providerState: {},
			workspaceRoot: "/tmp/project",
			eventSink: createMockEventSink(),
			abortSignal: new AbortController().signal,
			...inputOverrides,
		},
	};
}

const hashOf = (command: SendTurnCommand): string =>
	fingerprintHash(effectiveDispatchFingerprint(command));

describe("effectiveDispatchFingerprint", () => {
	it("is deterministic for the same effective dispatch request", () => {
		expect(hashOf(sendTurn())).toBe(hashOf(sendTurn()));
	});

	it("excludes runtime handles (eventSink, abortSignal)", () => {
		expect(hashOf(sendTurn())).toBe(
			hashOf(
				sendTurn({
					input: {
						eventSink: createMockEventSink(),
						abortSignal: new AbortController().signal,
					},
				}),
			),
		);
	});

	it("changes when prompt text changes", () => {
		expect(hashOf(sendTurn())).not.toBe(
			hashOf(sendTurn({ input: { prompt: "different" } })),
		);
	});

	it("changes when the provider instance changes", () => {
		expect(hashOf(sendTurn({ providerId: "claude" }))).not.toBe(
			hashOf(sendTurn({ providerId: "opencode" })),
		);
	});

	it("changes when the selected model changes", () => {
		expect(
			hashOf(
				sendTurn({
					input: { model: { providerId: "claude", modelId: "sonnet" } },
				}),
			),
		).not.toBe(
			hashOf(
				sendTurn({
					input: { model: { providerId: "claude", modelId: "opus" } },
				}),
			),
		);
	});

	it("changes when a provider option (variant) changes", () => {
		expect(hashOf(sendTurn({ input: { variant: "a" } }))).not.toBe(
			hashOf(sendTurn({ input: { variant: "b" } })),
		);
	});

	it("folds Claude contextWindow into the effective API model id (1m sonnet)", () => {
		const base = sendTurn({
			input: { model: { providerId: "claude", modelId: "sonnet" } },
		});
		const million = sendTurn({
			input: {
				model: { providerId: "claude", modelId: "sonnet" },
				contextWindow: "1m",
			},
		});
		expect(hashOf(base)).not.toBe(hashOf(million));
	});

	it("changes when the OpenCode model provider changes for the same model id (finding #6)", () => {
		const anthropic = sendTurn({
			providerId: "opencode",
			input: {
				model: { providerId: "anthropic", modelId: "claude-3-5-sonnet" },
			},
		});
		const openai = sendTurn({
			providerId: "opencode",
			input: { model: { providerId: "openai", modelId: "claude-3-5-sonnet" } },
		});
		expect(hashOf(anthropic)).not.toBe(hashOf(openai));
	});

	it("represents the Claude active-session model fallback when the command omits a model (finding #6)", () => {
		const command = sendTurn({ providerId: "claude" });
		const withSonnet = fingerprintHash(
			effectiveDispatchFingerprint(command, { activeSessionModelId: "sonnet" }),
		);
		const withOpus = fingerprintHash(
			effectiveDispatchFingerprint(command, { activeSessionModelId: "opus" }),
		);
		const withNone = fingerprintHash(effectiveDispatchFingerprint(command));
		expect(withSonnet).not.toBe(withOpus);
		expect(withSonnet).not.toBe(withNone);
	});

	it("ignores contextWindow when it does not derive a different model (opus has no 1m)", () => {
		const base = sendTurn({
			input: { model: { providerId: "claude", modelId: "opus" } },
		});
		const million = sendTurn({
			input: {
				model: { providerId: "claude", modelId: "opus" },
				contextWindow: "1m",
			},
		});
		expect(hashOf(base)).toBe(hashOf(million));
	});
});
