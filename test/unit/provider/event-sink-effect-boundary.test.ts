import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();

const source = (path: string) => readFileSync(join(REPO_ROOT, path), "utf8");

describe("EventSink Effect boundary", () => {
	it("keeps EventSink.push Effect-returning", () => {
		const providerTypes = source("src/lib/provider/types.ts");

		expect(providerTypes).toContain(
			"push(event: CanonicalEvent): Effect.Effect<void, unknown>;",
		);
		expect(providerTypes).not.toContain(
			"push(event: CanonicalEvent): Promise<void>",
		);
	});

	it("does not reintroduce runtime bridges for Claude EventSink persistence", () => {
		const prompt = source("src/lib/handlers/prompt.ts");
		const relayEventSink = source("src/lib/provider/relay-event-sink.ts");

		expect(prompt).not.toMatch(/Effect\.runPromise\([^)]*persistEvent/);
		expect(prompt).not.toMatch(/persistEvent:\s*\([^)]*\)\s*=>/);
		expect(relayEventSink).not.toMatch(/Effect\.run(?:Promise|Sync)/);
		expect(relayEventSink).not.toMatch(/runEffect/);
	});
});
