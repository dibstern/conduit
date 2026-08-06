// ─── OpenCode Runtime Ingress Must Not Publish To Relay ─────────────────────
// The OpenCode runtime ingress persists provider events and signals committed
// events to SessionEventBus. The legacy SSE translator (sse-wiring.ts) is the
// sole live-delivery path to the browser for OpenCode. If the ingress also
// publishes to the relay, each streamed text delta reaches the browser twice
// and renders doubled ("I'mI'm ready. ready.").

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type EffectOpenCodeRuntimeIngress,
	makeEffectOpenCodeRuntimeIngress,
	type OpenCodeRuntimeIngressLog,
} from "../../../../src/lib/domain/relay/Services/opencode-runtime-ingress-service.js";
import {
	makeProviderRuntimeIngestionLive,
	type ProviderRuntimeRelayPublisher,
} from "../../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import {
	type SessionEventBus,
	SessionEventBusTag,
} from "../../../../src/lib/domain/relay/Services/session-event-bus.js";
import { makePersistenceEffectLayer } from "../../../../src/lib/persistence/effect/live.js";
import { makeSSEEvent } from "../../../helpers/sse-factories.js";

const SESSION_ID = "sess-nopublish-001";

function makeLogger(): OpenCodeRuntimeIngressLog {
	return { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), verbose: vi.fn() };
}

function makeTestRuntime(
	dbPath: string,
	relayPublisher: ProviderRuntimeRelayPublisher,
	sessionEventBus: SessionEventBus,
) {
	const persistenceLayer = makePersistenceEffectLayer(dbPath);
	const sessionEventBusLayer = Layer.succeed(
		SessionEventBusTag,
		sessionEventBus,
	);
	return ManagedRuntime.make(
		Layer.mergeAll(
			persistenceLayer,
			makeProviderRuntimeIngestionLive({ relayPublisher }).pipe(
				Layer.provide(persistenceLayer),
				Layer.provideMerge(sessionEventBusLayer),
			),
		),
	);
}

describe("OpenCode runtime ingress does not publish to relay/browser", () => {
	let dir: string;
	let runtime: ReturnType<typeof makeTestRuntime> | undefined;
	let publishToBus: ReturnType<typeof vi.fn>;
	let publishToRelay: ReturnType<typeof vi.fn>;
	let hook: EffectOpenCodeRuntimeIngress;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "conduit-ingress-nopublish-"));
		publishToBus = vi.fn(() => Effect.void);
		publishToRelay = vi.fn(() => Effect.void);
		const rt = makeTestRuntime(
			join(dir, "events.db"),
			{ publish: publishToRelay },
			{
				publish: publishToBus,
				subscribe: () => Effect.dieMessage("unused in this test"),
			},
		);
		runtime = rt;
		hook = await rt.runPromise(makeEffectOpenCodeRuntimeIngress(makeLogger()));
	});

	afterEach(async () => {
		hook?.stopStatsLogging();
		await runtime?.dispose();
		rmSync(dir, { recursive: true, force: true });
	});

	async function ingest(
		event: Parameters<EffectOpenCodeRuntimeIngress["onSSEEventEffect"]>[0],
	) {
		const result = await Effect.runPromise(
			hook.onSSEEventEffect(event, SESSION_ID, "opencode"),
		);
		if (!result.ok) {
			throw new Error(`ingress failed for ${event.type}: ${result.reason}`);
		}
		return result;
	}

	it("persists a streamed text delta without publishing it to the browser", async () => {
		await ingest(
			makeSSEEvent("message.created", {
				sessionID: SESSION_ID,
				messageID: "msg-001",
				info: { role: "assistant", parts: [] },
			}),
		);
		await ingest(
			makeSSEEvent("message.part.delta", {
				sessionID: SESSION_ID,
				messageID: "msg-001",
				partID: "part-text-001",
				field: "text",
				delta: "Hello",
			}),
		);

		// The legacy translator is the only path allowed to deliver OpenCode
		// events to the browser. If the ingress publishes to the relay, deltas double.
		expect(publishToRelay).not.toHaveBeenCalled();
	});

	it("signals committed events to SessionEventBus without publishing to the browser", async () => {
		await ingest(
			makeSSEEvent("message.created", {
				sessionID: SESSION_ID,
				messageID: "msg-bus-001",
				info: { role: "assistant", parts: [] },
			}),
		);

		expect(publishToBus).toHaveBeenCalledTimes(1);
		expect(publishToBus).toHaveBeenCalledWith(
			expect.arrayContaining([
				expect.objectContaining({
					type: "session.created",
					sessionId: SESSION_ID,
				}),
				expect.objectContaining({
					type: "message.created",
					sessionId: SESSION_ID,
				}),
			]),
		);
		expect(publishToRelay).not.toHaveBeenCalled();
	});
});
