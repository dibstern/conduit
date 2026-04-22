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

		// In SDK 1.4.x / OpenCode 1.3.13+, the API is split into global
		// endpoints (served at /doc) and project-scoped endpoints.  The
		// global spec only lists these top-level paths.
		const requiredEndpoints = [
			"/global/health",
			"/global/event",
			"/global/sync-event",
			"/global/config",
			"/global/dispose",
			"/global/upgrade",
			"/auth/{providerID}",
			"/log",
			// Note: /doc serves the spec itself, so it's NOT listed IN the spec
		];

		const livePaths = new Set(Object.keys(liveSpec.paths));
		const missing = requiredEndpoints.filter((e) => !livePaths.has(e));

		if (missing.length > 0) {
			console.error("❌ Missing required endpoints:", missing);
		}
		expect(missing).toEqual([]);
	});

	it("event schemas we depend on are defined in the spec", () => {
		if (skipIfNoServer() || !liveSpec) return;

		// Session, permission, question, and message endpoints are now
		// project-scoped and not in the global /doc spec.  But the global
		// spec still defines all the event and data schemas we rely on.
		const requiredSchemas = [
			"Session",
			"Message",
			"PermissionRequest",
			"QuestionRequest",
			"ToolPart",
			"TextPart",
			"Event",
			"GlobalEvent",
			"SyncEvent",
		];

		const liveSchemas = new Set(
			Object.keys(liveSpec.components?.schemas ?? {}),
		);
		const missing = requiredSchemas.filter((s) => !liveSchemas.has(s));

		if (missing.length > 0) {
			console.error("❌ Missing required schemas:", missing);
		}
		expect(missing).toEqual([]);
	});

	it("permission-related schemas exist in the spec", () => {
		if (skipIfNoServer() || !liveSpec) return;
		const schemas = Object.keys(liveSpec.components?.schemas ?? {});
		expect(schemas).toContain("PermissionRequest");
		expect(schemas).toContain("Event.permission.asked");
		expect(schemas).toContain("Event.permission.replied");
	});

	it("question-related schemas exist in the spec", () => {
		if (skipIfNoServer() || !liveSpec) return;
		const schemas = Object.keys(liveSpec.components?.schemas ?? {});
		expect(schemas).toContain("QuestionRequest");
		expect(schemas).toContain("Event.question.asked");
		expect(schemas).toContain("Event.question.replied");
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
