import { describe, expect, it, vi } from "vitest";
import { createSilentLogger } from "../../src/lib/logger.js";
import {
	createMockHandlerDeps,
	createMockSSEWiringDeps,
} from "../helpers/mock-factories.js";

describe("mock-factories", () => {
	describe("createMockHandlerDeps", () => {
		it("accepts overrides", () => {
			const customLog = createSilentLogger();
			const deps = createMockHandlerDeps({ log: customLog });
			expect(deps.log).toBe(customLog);
		});

		it("accepts sub-object overrides", () => {
			const getClientsForSession = vi.fn(() => ["rpc-viewer"]);
			const deps = createMockHandlerDeps({
				wsHandler: {
					setClientSession: vi.fn(),
					getClientSession: vi.fn(),
					getClientsForSession,
				},
			});
			expect(deps.wsHandler.getClientsForSession).toBe(getClientsForSession);
		});
	});

	describe("createMockSSEWiringDeps", () => {
		it("accepts overrides", () => {
			const customLog = createSilentLogger();
			const deps = createMockSSEWiringDeps({ log: customLog });
			expect(deps.log).toBe(customLog);
		});
	});
});
