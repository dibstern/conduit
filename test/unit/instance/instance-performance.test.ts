// Verify config persistence handles large instance lists.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type DaemonConfig,
	saveDaemonConfig,
} from "../../../src/lib/daemon/config-persistence.js";

describe("Config persistence performance", () => {
	it("saveDaemonConfig handles large instance lists", () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "perf-test-"));
		const instances = Array.from({ length: 50 }, (_, i) => ({
			id: `inst-${i}`,
			name: `Instance ${i}`,
			port: 3000 + i,
			managed: true,
		}));

		const config: DaemonConfig = {
			pid: 1,
			port: 2633,
			pinHash: null,
			tls: false,
			debug: false,
			keepAwake: false,
			dangerouslySkipPermissions: false,
			projects: [],
			instances,
		};

		const start = performance.now();
		saveDaemonConfig(config, tmpDir);
		const elapsed = performance.now() - start;
		expect(elapsed).toBeLessThan(100); // Well under 100ms
	});
});
