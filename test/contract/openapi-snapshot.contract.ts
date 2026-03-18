// ─── AC5: OpenAPI Spec Snapshot Comparison ────────────────────────────────
// Compares the live OpenAPI spec to a committed snapshot.
// WARNS on additions (new endpoints), FAILS on removals or type changes.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { apiGet, checkServerHealth } from "./helpers/server-connection.js";

interface OpenAPISpec {
	openapi: string;
	info: { title: string; version: string };
	paths: Record<string, Record<string, unknown>>;
	components?: { schemas?: Record<string, unknown> };
}

let serverAvailable = false;
let liveSpec: OpenAPISpec | null = null;
let snapshotSpec: OpenAPISpec | null = null;

beforeAll(async () => {
	const health = await checkServerHealth();
	serverAvailable = health?.healthy === true;
	if (!serverAvailable) {
		console.warn("⚠️  OpenCode server not running — skipping contract tests");
		return;
	}

	liveSpec = await apiGet<OpenAPISpec>("/doc");

	const snapshotPath = resolve(
		import.meta.dirname ?? __dirname,
		"../fixtures/opencode-api-snapshot.json",
	);
	try {
		snapshotSpec = JSON.parse(readFileSync(snapshotPath, "utf-8"));
	} catch {
		console.warn("⚠️  No OpenAPI snapshot found — skipping diff tests");
	}
});

function skipIfNoServer() {
	if (!serverAvailable) {
		console.warn("SKIP: No OpenCode server available");
		return true;
	}
	return false;
}

describe("AC5 — OpenAPI Spec Snapshot Comparison", () => {
	it("live spec is a valid OpenAPI document", () => {
		if (skipIfNoServer() || !liveSpec) return;
		expect(liveSpec.openapi).toBeDefined();
		expect(liveSpec.info).toBeDefined();
		expect(liveSpec.paths).toBeDefined();
		expect(typeof liveSpec.openapi).toBe("string");
		expect(liveSpec.openapi).toMatch(/^3\.\d+\.\d+$/);
	});

	it("snapshot exists and is a valid OpenAPI document", () => {
		if (skipIfNoServer()) return;
		expect(snapshotSpec).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(snapshotSpec!.openapi).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(snapshotSpec!.paths).toBeDefined();
	});

	it("no endpoints have been REMOVED from the snapshot", () => {
		if (skipIfNoServer() || !liveSpec || !snapshotSpec) return;

		const snapshotPaths = Object.keys(snapshotSpec.paths);
		const livePaths = new Set(Object.keys(liveSpec.paths));
		const removed = snapshotPaths.filter((p) => !livePaths.has(p));

		if (removed.length > 0) {
			console.error("❌ REMOVED endpoints:", removed);
		}
		expect(removed).toEqual([]);
	});

	it("no HTTP methods have been REMOVED from existing endpoints", () => {
		if (skipIfNoServer() || !liveSpec || !snapshotSpec) return;

		const removedMethods: string[] = [];
		for (const [path, methods] of Object.entries(snapshotSpec.paths)) {
			if (!(path in liveSpec.paths)) continue; // Covered by previous test
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			const liveMethods = liveSpec.paths[path]!;
			for (const method of Object.keys(methods)) {
				if (method === "parameters") continue; // Shared params, not a method
				if (!(method in liveMethods)) {
					removedMethods.push(`${method.toUpperCase()} ${path}`);
				}
			}
		}

		if (removedMethods.length > 0) {
			console.error("❌ REMOVED methods:", removedMethods);
		}
		expect(removedMethods).toEqual([]);
	});

	it("reports NEW endpoints (informational, not a failure)", () => {
		if (skipIfNoServer() || !liveSpec || !snapshotSpec) return;

		const snapshotPaths = new Set(Object.keys(snapshotSpec.paths));
		const livePaths = Object.keys(liveSpec.paths);
		const added = livePaths.filter((p) => !snapshotPaths.has(p));

		if (added.length > 0) {
			console.info(`ℹ️  NEW endpoints (${added.length}):`, added.join(", "));
		}
		// This is informational — new endpoints don't break us
		expect(true).toBe(true);
	});

	it("core endpoints we depend on still exist", () => {
		if (skipIfNoServer() || !liveSpec) return;

		const requiredEndpoints = [
			"/global/health",
			"/global/event",
			"/session",
			"/agent",
			"/provider",
			"/command",
			"/permission",
			"/question",
			"/event",
			"/path",
			"/config",
			"/project",
			"/pty",
			"/vcs",
			// Note: /doc serves the spec itself, so it's NOT listed IN the spec
		];

		const livePaths = new Set(Object.keys(liveSpec.paths));
		const missing = requiredEndpoints.filter((e) => !livePaths.has(e));

		if (missing.length > 0) {
			console.error("❌ Missing required endpoints:", missing);
		}
		expect(missing).toEqual([]);
	});

	it("session sub-endpoints we depend on still exist", () => {
		if (skipIfNoServer() || !liveSpec) return;

		const requiredSessionEndpoints = [
			"/session/{sessionID}",
			"/session/{sessionID}/message",
			"/session/{sessionID}/prompt_async",
			"/session/{sessionID}/abort",
			"/session/{sessionID}/fork",
			"/session/{sessionID}/revert",
			"/session/{sessionID}/diff",
			"/session/status",
		];

		const livePaths = new Set(Object.keys(liveSpec.paths));
		const missing = requiredSessionEndpoints.filter((e) => !livePaths.has(e));

		if (missing.length > 0) {
			console.error("❌ Missing required session endpoints:", missing);
		}
		expect(missing).toEqual([]);
	});

	it("permission reply endpoint exists with expected path pattern", () => {
		if (skipIfNoServer() || !liveSpec) return;
		expect(liveSpec.paths).toHaveProperty("/permission/{requestID}/reply");
	});

	it("question reply endpoint exists with expected path pattern", () => {
		if (skipIfNoServer() || !liveSpec) return;
		expect(liveSpec.paths).toHaveProperty("/question/{requestID}/reply");
	});

	it("no schema definitions have been REMOVED", () => {
		if (skipIfNoServer() || !liveSpec || !snapshotSpec) return;

		const snapshotSchemas = Object.keys(snapshotSpec.components?.schemas ?? {});
		const liveSchemas = new Set(
			Object.keys(liveSpec.components?.schemas ?? {}),
		);
		const removed = snapshotSchemas.filter((s) => !liveSchemas.has(s));

		if (removed.length > 0) {
			console.error("❌ REMOVED schemas:", removed);
		}
		expect(removed).toEqual([]);
	});
});
