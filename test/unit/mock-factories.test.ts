import { describe, expect, it, vi } from "vitest";
import { createSilentLogger } from "../../src/lib/logger.js";
import {
	createMockHandlerDeps,
	createMockSSEWiringDeps,
} from "../helpers/mock-factories.js";

describe("mock-factories", () => {
	describe("createMockHandlerDeps", () => {
		it("returns a fully-typed HandlerDeps object", () => {
			const deps = createMockHandlerDeps();
			expect(deps.wsHandler.setClientSession).toBeDefined();
			expect(deps.wsHandler.getClientSession).toBeDefined();
			expect(deps.wsHandler.getClientsForSession).toBeDefined();
			expect(deps.client).toBeDefined();
			expect(deps.sessionMgr).toBeDefined();
			expect(deps.ptyManager).toBeDefined();
			expect(deps.config).toBeDefined();
			expect(deps.log).toBeDefined();
			expect(deps.connectPtyUpstream).toBeDefined();
		});

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
		it("returns a fully-typed SSEWiringDeps object", () => {
			const deps = createMockSSEWiringDeps();
			expect(deps.translator.translate).toBeDefined();
			expect(deps.translator.reset).toBeDefined();
			expect(deps.log).toBeDefined();
		});

		it("accepts overrides", () => {
			const customLog = createSilentLogger();
			const deps = createMockSSEWiringDeps({ log: customLog });
			expect(deps.log).toBe(customLog);
		});
	});
});
