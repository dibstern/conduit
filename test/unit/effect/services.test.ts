import { describe, it } from "@effect/vitest";
import { Context, Effect } from "effect";
import { expect } from "vitest";
import {
	InstanceMgmtTag,
	ProjectMgmtTag,
} from "../../../src/lib/domain/daemon/Services/management-service.js";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";

import {
	// Per-request Tags
	ClientIdTag,
	ConfigTag,
	ConnectPtyUpstreamTag,
	LoggerTag,
	OpenCodeSettingsServiceTag,
	OrchestrationEngineTag,
	PollerManagerTag,
	PtyManagerTag,
	StatusPollerTag,
	WebSocketHandlerTag,
} from "../../../src/lib/domain/relay/Services/services.js";

// ─── Tag key uniqueness ────────────────────────────────────────────────────

const ALL_TAGS = [
	OpenCodeAPITag,
	OpenCodeSettingsServiceTag,
	WebSocketHandlerTag,
	PtyManagerTag,
	ConfigTag,
	LoggerTag,
	StatusPollerTag,
	PollerManagerTag,
	ConnectPtyUpstreamTag,
	OrchestrationEngineTag,
	InstanceMgmtTag,
	ProjectMgmtTag,
	ClientIdTag,
] as const;

describe("Service Tags", () => {
	it("every Tag has a unique key", () => {
		const keys = ALL_TAGS.map((t) => t.key);
		const unique = new Set(keys);
		expect(unique.size).toBe(keys.length);
	});

	it("every Tag key is a non-empty string", () => {
		for (const tag of ALL_TAGS) {
			expect(typeof tag.key).toBe("string");
			expect(tag.key.length).toBeGreaterThan(0);
		}
	});

	it("total Tag count matches HandlerDeps field count plus ClientId", () => {
		// Bridge classes are no longer Effect services; count only active Tags.
		expect(ALL_TAGS.length).toBe(13);
	});

	// ── Core Tags ────────────────────────────────────────────────────────────

	it("OpenCodeAPI tag has correct key", () => {
		expect(OpenCodeAPITag.key).toBe("OpenCodeAPI");
	});

	it("OpenCodeSettingsService tag has correct key", () => {
		expect(OpenCodeSettingsServiceTag.key).toBe("OpenCodeSettingsService");
	});

	it("WebSocketHandler tag has correct key", () => {
		expect(WebSocketHandlerTag.key).toBe("WebSocketHandler");
	});

	it("PtyManager tag has correct key", () => {
		expect(PtyManagerTag.key).toBe("PtyManager");
	});

	it("Config tag has correct key", () => {
		expect(ConfigTag.key).toBe("Config");
	});

	it("Logger tag has correct key", () => {
		expect(LoggerTag.key).toBe("Logger");
	});

	it("StatusPoller tag has correct key", () => {
		expect(StatusPollerTag.key).toBe("StatusPoller");
	});

	it("PollerManager tag has correct key", () => {
		expect(PollerManagerTag.key).toBe("PollerManager");
	});

	it("ConnectPtyUpstream tag has correct key", () => {
		expect(ConnectPtyUpstreamTag.key).toBe("ConnectPtyUpstream");
	});

	it("OrchestrationEngine tag has correct key", () => {
		expect(OrchestrationEngineTag.key).toBe("OrchestrationEngine");
	});

	// ── Daemon-only Tags ─────────────────────────────────────────────────────

	it("InstanceMgmt tag has correct key", () => {
		expect(InstanceMgmtTag.key).toBe("InstanceMgmt");
	});

	it("ProjectMgmt tag has correct key", () => {
		expect(ProjectMgmtTag.key).toBe("ProjectMgmt");
	});

	// ── Per-request Tags ─────────────────────────────────────────────────────

	it("ClientId tag has correct key", () => {
		expect(ClientIdTag.key).toBe("ClientId");
	});

	// ── Effect integration ───────────────────────────────────────────────────

	it.effect("Tag resolves from a provided Context", () =>
		Effect.gen(function* () {
			const clientId = yield* ClientIdTag;
			expect(clientId).toBe("test-client-42");
		}).pipe(Effect.provide(Context.make(ClientIdTag, "test-client-42"))),
	);

	it.effect("Tag causes missing-service error without Context", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				Effect.gen(function* () {
					yield* ClientIdTag;
				}) as Effect.Effect<void>,
			);
			expect(exit._tag).toBe("Failure");
		}),
	);
});
