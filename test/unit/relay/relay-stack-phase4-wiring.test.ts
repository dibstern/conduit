// test/unit/relay/relay-stack-phase4-wiring.test.ts
// ─── Phase 4 Relay Stack Wiring Test ─────────────────────────────────────────
// Validates the wiring pattern used in relay-stack.ts for Phase 4:
// - ReadQueryService, ReadFlags, and ReadAdapter are created when persistence exists
// - ReadAdapter is passed to HandlerDeps
// - ReadAdapter is undefined when persistence is not configured

import { describe, expect, it } from "vitest";
import { ReadAdapter } from "../../../src/lib/persistence/read-adapter.js";
import {
	createReadFlags,
	type ReadFlagConfig,
	type ReadFlags,
} from "../../../src/lib/persistence/read-flags.js";
import type { ReadQueryService } from "../../../src/lib/persistence/read-query-service.js";

/**
 * Simulates the Phase 4 wiring in createProjectRelay().
 * This is the exact pattern used in relay-stack.ts:
 *
 * ```ts
 * const readQuery = config.persistence
 *   ? new ReadQueryService(config.persistence.db) : undefined;
 * const readFlags = config.persistence
 *   ? createReadFlags(config.readFlags) : undefined;
 * const readAdapter = readQuery && readFlags
 *   ? new ReadAdapter(readQuery, readFlags) : undefined;
 * ```
 */
function simulateRelayStackWiring(opts: {
	hasPersistence: boolean;
	readFlagsConfig?: ReadFlagConfig;
}): {
	readQuery: ReadQueryService | undefined;
	readFlags: ReadFlags | undefined;
	readAdapter: ReadAdapter | undefined;
} {
	// Simulate: readQuery is only created when persistence exists
	const readQuery = opts.hasPersistence ? ({} as ReadQueryService) : undefined;
	// Simulate: readFlags is only created when persistence exists
	const readFlags = opts.hasPersistence
		? createReadFlags(opts.readFlagsConfig)
		: undefined;
	// Simulate: readAdapter requires both
	const readAdapter =
		readQuery && readFlags ? new ReadAdapter(readQuery, readFlags) : undefined;

	return { readQuery, readFlags, readAdapter };
}

describe("Relay stack Phase 4 wiring", () => {
	it("creates readAdapter when persistence is available", () => {
		const { readQuery, readFlags, readAdapter } = simulateRelayStackWiring({
			hasPersistence: true,
		});

		expect(readQuery).toBeDefined();
		expect(readFlags).toBeDefined();
		expect(readAdapter).toBeDefined();
		expect(readAdapter).toBeInstanceOf(ReadAdapter);
		expect(readAdapter?.isConfigured).toBe(true);
	});

	it("does not create readAdapter when persistence is absent", () => {
		const { readQuery, readFlags, readAdapter } = simulateRelayStackWiring({
			hasPersistence: false,
		});

		expect(readQuery).toBeUndefined();
		expect(readFlags).toBeUndefined();
		expect(readAdapter).toBeUndefined();
	});

	it("passes readFlagsConfig through to createReadFlags", () => {
		const { readFlags } = simulateRelayStackWiring({
			hasPersistence: true,
			readFlagsConfig: {
				toolContent: "sqlite",
				sessionList: "shadow",
			},
		});

		expect(readFlags?.toolContent).toBe("sqlite");
		expect(readFlags?.sessionList).toBe("shadow");
		expect(readFlags?.forkMetadata).toBe("legacy"); // default
	});

	it("readAdapter uses readFlags to determine mode", () => {
		const { readAdapter } = simulateRelayStackWiring({
			hasPersistence: true,
			readFlagsConfig: {
				toolContent: "sqlite",
				sessionStatus: "legacy",
			},
		});

		expect(readAdapter?.isSqliteFor("toolContent")).toBe(true);
		expect(readAdapter?.isSqliteFor("sessionStatus")).toBe(false);
	});

	describe("HandlerDeps integration pattern", () => {
		it("conditional spread only adds readAdapter when defined", () => {
			// This simulates the pattern in handler-deps-wiring.ts:
			// ...(readAdapter != null && { readAdapter }),
			const { readAdapter } = simulateRelayStackWiring({
				hasPersistence: true,
			});

			const handlerDeps = {
				// ...other deps...
				...(readAdapter != null && { readAdapter }),
			};

			expect(handlerDeps.readAdapter).toBeDefined();
			expect(handlerDeps.readAdapter).toBeInstanceOf(ReadAdapter);
		});

		it("conditional spread omits readAdapter when undefined", () => {
			const { readAdapter } = simulateRelayStackWiring({
				hasPersistence: false,
			});

			const handlerDeps: Record<string, unknown> = {
				// ...other deps...
				...(readAdapter != null && { readAdapter }),
			};

			expect("readAdapter" in handlerDeps).toBe(false);
		});
	});
});
