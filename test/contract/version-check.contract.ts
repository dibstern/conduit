// ─── AC7: Version Pinning Validation ──────────────────────────────────────
// Verifies that the running OpenCode server matches the pinned version.

import { beforeAll, describe, expect, it } from "vitest";
import {
	checkServerHealth,
	getPinnedVersion,
} from "./helpers/server-connection.js";

describe("AC7 — Version Pinning", () => {
	let serverHealth: { healthy: boolean; version: string } | null = null;
	let pinnedVersion: string;

	beforeAll(async () => {
		pinnedVersion = getPinnedVersion();
		serverHealth = await checkServerHealth();
		if (!serverHealth) {
			console.warn("⚠️  OpenCode server not running — skipping contract tests");
		}
	});

	it("should have a .opencode-version file with a valid semver-like version", () => {
		expect(pinnedVersion).toBeTruthy();
		// Must look like a version string (e.g., "1.2.6" or "0.1.0-beta.1")
		expect(pinnedVersion).toMatch(/^\d+\.\d+\.\d+/);
	});

	it("should connect to a running OpenCode server", () => {
		if (!serverHealth) {
			console.warn("SKIP: No OpenCode server available");
			return;
		}
		expect(serverHealth.healthy).toBe(true);
		expect(typeof serverHealth.version).toBe("string");
	});

	it("should match the pinned version", () => {
		if (!serverHealth) {
			console.warn("SKIP: No OpenCode server available");
			return;
		}
		if (serverHealth.version !== pinnedVersion) {
			console.warn(
				`⚠️  Version mismatch: server=${serverHealth.version}, pinned=${pinnedVersion}`,
			);
		}
		expect(serverHealth.version).toBe(pinnedVersion);
	});

	it("health endpoint returns { healthy: boolean, version: string }", () => {
		if (!serverHealth) {
			console.warn("SKIP: No OpenCode server available");
			return;
		}
		expect(serverHealth).toHaveProperty("healthy");
		expect(serverHealth).toHaveProperty("version");
		expect(typeof serverHealth.healthy).toBe("boolean");
		expect(typeof serverHealth.version).toBe("string");
		// Should NOT have the old "ok" field
		expect(serverHealth).not.toHaveProperty("ok");
	});
});
