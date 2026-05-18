import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();

const source = (path: string) => readFileSync(join(REPO_ROOT, path), "utf8");

describe("EventSink Effect boundary", () => {
	it("keeps EventSink.push Effect-returning", () => {
		const providerTypes = source("src/lib/provider/types.ts");

		expect(providerTypes).toContain(
			"event: ProviderRuntimeEvent | CanonicalEvent,",
		);
		expect(providerTypes).toContain("): Effect.Effect<void, unknown>;");
		expect(providerTypes).not.toContain(
			"push(event: CanonicalEvent): Promise<void>",
		);
	});

	it("keeps EventSink permission and question waits Effect-returning", () => {
		const providerTypes = source("src/lib/provider/types.ts");
		const prompt = source("src/lib/handlers/prompt.ts");

		expect(providerTypes).toMatch(
			/requestPermission\(\s*request: PermissionRequest,\s*\): Effect\.Effect<PermissionResponse, unknown>;/,
		);
		expect(providerTypes).toMatch(
			/requestQuestion\(\s*request: QuestionRequest,\s*\): Effect\.Effect<Record<string, unknown>, unknown>;/,
		);
		expect(providerTypes).not.toMatch(
			/requestPermission\(request: PermissionRequest\): Promise</,
		);
		expect(providerTypes).not.toMatch(
			/requestQuestion\(request: QuestionRequest\): Promise</,
		);
		expect(prompt).not.toContain("Runtime.runPromise");
	});

	it("does not reintroduce runtime bridges for Claude EventSink persistence", () => {
		const prompt = source("src/lib/handlers/prompt.ts");
		const relayEventSink = source("src/lib/provider/relay-event-sink.ts");

		expect(prompt).not.toMatch(/Effect\.runPromise\([^)]*persistEvent/);
		expect(prompt).not.toMatch(/persistEvent:\s*\([^)]*\)\s*=>/);
		expect(relayEventSink).not.toMatch(/Effect\.run(?:Promise|Sync)/);
		expect(relayEventSink).not.toMatch(/runEffect/);
	});

	it("uses Effect Deferred for EventSink permission/question waits", () => {
		const eventSink = source("src/lib/provider/event-sink.ts");

		expect(eventSink).toContain("Deferred.make<PermissionResponse");
		expect(eventSink).toContain("Deferred.make<Record<string, unknown>");
		expect(eventSink).not.toContain("createDeferred");
		expect(eventSink).not.toContain("deferred.promise");
		expect(eventSink).not.toMatch(/Effect\.tryPromise\([^)]*deferred/);
	});

	it("keeps missing pending interaction failures typed", () => {
		const relayEventSink = source("src/lib/provider/relay-event-sink.ts");

		expect(relayEventSink).toContain("MissingPendingInteractions");
		expect(relayEventSink).not.toMatch(
			/throw new Error\([^)]*pendingInteractions/,
		);
		expect(relayEventSink).not.toContain(
			"RelayEventSink requires pendingInteractions for permission/question requests",
		);
	});
});
