import { describe, expect, it, vi } from "vitest";
import { handleScanNow } from "../../../src/lib/handlers/instance.js";
import { createMockHandlerDeps } from "../../helpers/mock-factories.js";

describe("handleScanNow", () => {
	it("triggers scan and sends result to requesting client", async () => {
		const deps = createMockHandlerDeps({
			scanDeps: {
				triggerScan: vi.fn().mockResolvedValue({
					discovered: [4098],
					lost: [4099],
					active: [4096, 4098],
				}),
			},
		});

		await handleScanNow(deps, "client-1", {});

		expect(deps.scanDeps?.triggerScan).toHaveBeenCalled();
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "scan_result",
			discovered: [4098],
			lost: [4099],
			active: [4096, 4098],
		});
	});

	it("sends error when scanning not available", async () => {
		const deps = createMockHandlerDeps();
		// scanDeps is undefined by default

		await handleScanNow(deps, "client-1", {});

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "error",
			code: "INSTANCE_ERROR",
			message: "Port scanning not available",
		});
	});

	it("handles scan failure gracefully", async () => {
		const deps = createMockHandlerDeps({
			scanDeps: {
				triggerScan: vi.fn().mockRejectedValue(new Error("scan failed")),
			},
		});

		await handleScanNow(deps, "client-1", {});

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "error",
			code: "INSTANCE_ERROR",
			message: expect.stringContaining("scan failed"),
		});
	});
});
