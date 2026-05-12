import { describe, it } from "@effect/vitest";
import { Context, Effect } from "effect";
import { expect } from "vitest";

import {
	ClaudeEventPersistTag,
	// Per-request Tags
	ClientIdTag,
	ConfigTag,
	ConnectPtyUpstreamTag,
	// Daemon-only Tags
	InstanceMgmtTag,
	LoggerTag,
	// Core Tags
	OpenCodeAPITag,
	OpenCodeSettingsServiceTag,
	OrchestrationEngineTag,
	PermissionBridgeTag,
	PollerManagerTag,
	ProjectMgmtTag,
	ProviderStateServiceTag,
	PtyManagerTag,
	QuestionBridgeTag,
	// Persistence extension Tags
	ReadQueryTag,
	ScanDepsTag,
	SessionManagerTag,
	SessionOverridesTag,
	SessionRegistryTag,
	StatusPollerTag,
	WebSocketHandlerTag,
} from "../../../src/lib/effect/services.js";

// ─── Tag key uniqueness ────────────────────────────────────────────────────

const ALL_TAGS = [
	OpenCodeAPITag,
	OpenCodeSettingsServiceTag,
	SessionManagerTag,
	WebSocketHandlerTag,
	PermissionBridgeTag,
	QuestionBridgeTag,
	SessionOverridesTag,
	PtyManagerTag,
	ConfigTag,
	LoggerTag,
	StatusPollerTag,
	SessionRegistryTag,
	PollerManagerTag,
	ConnectPtyUpstreamTag,
	OrchestrationEngineTag,
	ReadQueryTag,
	ClaudeEventPersistTag,
	ProviderStateServiceTag,
	InstanceMgmtTag,
	ProjectMgmtTag,
	ScanDepsTag,
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
		// HandlerDeps has 20 fields (13 required + 7 optional) + 1 extracted handler service + 1 per-request.
		expect(ALL_TAGS.length).toBe(22);
	});

	// ── Core Tags ────────────────────────────────────────────────────────────

	it("OpenCodeAPI tag has correct key", () => {
		expect(OpenCodeAPITag.key).toBe("OpenCodeAPI");
	});

	it("OpenCodeSettingsService tag has correct key", () => {
		expect(OpenCodeSettingsServiceTag.key).toBe("OpenCodeSettingsService");
	});

	it("SessionManager tag has correct key", () => {
		expect(SessionManagerTag.key).toBe("SessionManager");
	});

	it("WebSocketHandler tag has correct key", () => {
		expect(WebSocketHandlerTag.key).toBe("WebSocketHandler");
	});

	it("PermissionBridge tag has correct key", () => {
		expect(PermissionBridgeTag.key).toBe("PermissionBridge");
	});

	it("QuestionBridge tag has correct key", () => {
		expect(QuestionBridgeTag.key).toBe("QuestionBridge");
	});

	it("SessionOverrides tag has correct key", () => {
		expect(SessionOverridesTag.key).toBe("SessionOverrides");
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

	it("SessionRegistry tag has correct key", () => {
		expect(SessionRegistryTag.key).toBe("SessionRegistry");
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

	// ── Persistence extension Tags ───────────────────────────────────────────

	it("ReadQuery tag has correct key", () => {
		expect(ReadQueryTag.key).toBe("ReadQuery");
	});

	it("ClaudeEventPersist tag has correct key", () => {
		expect(ClaudeEventPersistTag.key).toBe("ClaudeEventPersist");
	});

	it("ProviderStateService tag has correct key", () => {
		expect(ProviderStateServiceTag.key).toBe("ProviderStateService");
	});

	// ── Daemon-only Tags ─────────────────────────────────────────────────────

	it("InstanceMgmt tag has correct key", () => {
		expect(InstanceMgmtTag.key).toBe("InstanceMgmt");
	});

	it("ProjectMgmt tag has correct key", () => {
		expect(ProjectMgmtTag.key).toBe("ProjectMgmt");
	});

	it("ScanDeps tag has correct key", () => {
		expect(ScanDepsTag.key).toBe("ScanDeps");
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
