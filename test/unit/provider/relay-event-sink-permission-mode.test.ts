// test/unit/provider/relay-event-sink-permission-mode.test.ts
//
// The SDK is the source of truth for a session's permission mode, so a
// translator-reported change has to reach all three places conduit keeps one:
// the durable event log, the relay's in-memory override (which the *next*
// turn reads), and the connected clients' picker.

import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { ProviderRuntimeEvent } from "../../../src/lib/contracts/providers/provider-runtime-event.js";
import type { CanonicalEvent } from "../../../src/lib/persistence/events.js";
import { createRelayEventSink } from "../../../src/lib/provider/relay-event-sink.js";
import type { SessionPermissionMode } from "../../../src/lib/shared-types.js";
import type { RelayMessage } from "../../../src/lib/types.js";

const modeChanged = (mode: SessionPermissionMode): ProviderRuntimeEvent => ({
	eventId: `evt_${mode}`,
	sessionId: "ses-1",
	type: "session.permission_mode_changed",
	data: { sessionId: "ses-1", mode },
	metadata: {},
	providerId: "claude",
	providerRefs: {},
	rawSource: { kind: "test.provider-runtime" },
	createdAt: Date.now(),
});

describe("createRelayEventSink — SDK-reported permission mode", () => {
	it("persists the change, updates the live override, and tells clients", async () => {
		const send = vi.fn<(msg: RelayMessage) => void>();
		const persisted: CanonicalEvent[] = [];
		const applied: SessionPermissionMode[] = [];
		const sink = createRelayEventSink({
			sessionId: "ses-1",
			send,
			persist: {
				persistEvent: (event) =>
					Effect.sync(() => {
						persisted.push(event);
					}),
			},
			applyReportedPermissionMode: (mode) =>
				Effect.sync(() => {
					applied.push(mode);
				}),
		});

		await Effect.runPromise(sink.push(modeChanged("acceptEdits")));

		expect(persisted.map((e) => [e.type, e.data])).toEqual([
			[
				"session.permission_mode_changed",
				{ sessionId: "ses-1", mode: "acceptEdits" },
			],
		]);
		expect(applied).toEqual(["acceptEdits"]);
		expect(send).toHaveBeenCalledWith({
			type: "permission_mode_info",
			sessionId: "ses-1",
			mode: "acceptEdits",
		});
	});

	// The override drives the next turn's query options; a persist failure that
	// swallowed it would leave the SDK and conduit disagreeing again.
	it("still updates the live override when the sink has no persistence", async () => {
		const applied: SessionPermissionMode[] = [];
		const sink = createRelayEventSink({
			sessionId: "ses-1",
			send: vi.fn(),
			applyReportedPermissionMode: (mode) =>
				Effect.sync(() => {
					applied.push(mode);
				}),
		});

		await Effect.runPromise(sink.push(modeChanged("plan")));

		expect(applied).toEqual(["plan"]);
	});
});
