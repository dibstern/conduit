// ─── OpenCode Runtime Ingress Must Not Publish (streaming dedup regression) ──
// The OpenCode runtime ingress exists to PERSIST provider events into the event
// store. The legacy SSE translator (sse-wiring.ts) is the sole live-delivery
// path to the browser for OpenCode. Because the ingress shares the same
// publisher-bearing ProviderRuntimeIngestion instance that the Claude
// orchestration path needs, it used to ALSO publish every event — so each
// streamed text delta reached the browser twice and rendered doubled
// ("I'mI'm ready. ready."). This test locks the ingress to persist-only.

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
import { makePersistenceEffectLayer } from "../../../../src/lib/persistence/effect/live.js";
import { makeSSEEvent } from "../../../helpers/sse-factories.js";

const SESSION_ID = "sess-nopublish-001";

function makeLogger(): OpenCodeRuntimeIngressLog {
	return { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), verbose: vi.fn() };
}

function makeTestRuntime(
	dbPath: string,
	relayPublisher: ProviderRuntimeRelayPublisher,
) {
	const persistenceLayer = makePersistenceEffectLayer(dbPath);
	return ManagedRuntime.make(
		Layer.mergeAll(
			persistenceLayer,
			makeProviderRuntimeIngestionLive({ relayPublisher }).pipe(
				Layer.provide(persistenceLayer),
			),
		),
	);
}

describe("OpenCode runtime ingress is persist-only (does not publish to browser)", () => {
	let dir: string;
	let runtime: ReturnType<typeof makeTestRuntime> | undefined;
	let publish: ReturnType<typeof vi.fn>;
	let hook: EffectOpenCodeRuntimeIngress;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "conduit-ingress-nopublish-"));
		publish = vi.fn(() => Effect.void);
		const rt = makeTestRuntime(join(dir, "events.db"), { publish });
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
			hook.onSSEEventEffect(event, SESSION_ID),
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
		// events to the browser. If the ingress publishes anything, deltas double.
		expect(publish).not.toHaveBeenCalled();
	});
});
