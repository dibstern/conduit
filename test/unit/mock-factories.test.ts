import { describe, expect, it, vi } from "vitest";
import { createSilentLogger } from "../../src/lib/logger.js";
import {
	createMockClientInitDeps,
	createMockHandlerDeps,
	createMockSSEWiringDeps,
} from "../helpers/mock-factories.js";

describe("mock-factories", () => {
	describe("createMockHandlerDeps", () => {
		it("returns a fully-typed HandlerDeps object", () => {
			const deps = createMockHandlerDeps();
			expect(deps.wsHandler.broadcast).toBeDefined();
			expect(deps.wsHandler.sendTo).toBeDefined();
			expect(deps.wsHandler.setClientSession).toBeDefined();
			expect(deps.wsHandler.getClientSession).toBeDefined();
			expect(deps.wsHandler.getClientsForSession).toBeDefined();
			expect(deps.wsHandler.sendToSession).toBeDefined();
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
			const customBroadcast = vi.fn();
			const deps = createMockHandlerDeps({
				wsHandler: {
					broadcast: customBroadcast,
					sendTo: vi.fn(),
					setClientSession: vi.fn(),
					getClientSession: vi.fn(),
					getClientsForSession: vi.fn(),
					sendToSession: vi.fn(),
				},
			});
			expect(deps.wsHandler.broadcast).toBe(customBroadcast);
		});
	});

	describe("createMockSSEWiringDeps", () => {
		it("returns a fully-typed SSEWiringDeps object", () => {
			const deps = createMockSSEWiringDeps();
			expect(deps.translator.translate).toBeDefined();
			expect(deps.translator.reset).toBeDefined();
			expect(deps.wsHandler.broadcast).toBeDefined();
			expect(deps.wsHandler.sendToSession).toBeDefined();
			expect(deps.sessionService).toBeDefined();
			expect(deps.pendingPermissions.record).toBeDefined();
			expect(deps.processingTimeouts).toBeDefined();
			expect(deps.log).toBeDefined();
		});

		it("accepts overrides", () => {
			const customLog = createSilentLogger();
			const deps = createMockSSEWiringDeps({ log: customLog });
			expect(deps.log).toBe(customLog);
		});
	});

	describe("createMockClientInitDeps", () => {
		it("returns a fully-typed ClientInitDeps object", () => {
			const deps = createMockClientInitDeps();
			expect(deps.wsHandler.broadcast).toBeDefined();
			expect(deps.wsHandler.sendTo).toBeDefined();
			expect(deps.wsHandler.setClientSession).toBeDefined();
			expect(deps.client).toBeDefined();
			expect(deps.sessionService).toBeDefined();
			expect(deps.overrideState.hasActiveProcessingTimeout).toBeDefined();
			expect(deps.terminal.replay).toBeDefined();
			expect(deps.modelService.getSession).toBeDefined();
			expect(deps.modelService.listProviders).toBeDefined();
			expect(deps.pendingInteractions.listPendingPermissions).toBeDefined();
			expect(deps.log).toBeDefined();
		});

		it("accepts overrides", () => {
			const customLog = createSilentLogger();
			const deps = createMockClientInitDeps({ log: customLog });
			expect(deps.log).toBe(customLog);
		});
	});
});
