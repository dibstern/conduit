// Verifies that the scanInFlight flag is properly managed across outcomes:
// success (ScanNow reply) and state reset. RPC failure is cleared by the
// caller (InstancesSettingsTab), not by a raw socket error frame.

import { describe, expect, it } from "vitest";
import {
	applyScanNowResponse,
	beginScan,
	clearInstanceState,
	getScanResult,
	isScanInFlight,
} from "../../../src/lib/frontend/stores/instance.svelte.js";

describe("scanInFlight state management", () => {
	it("beginScan sets scanInFlight without depending on legacy WS commands", () => {
		clearInstanceState();
		beginScan();
		expect(isScanInFlight()).toBe(true);
	});

	it("applyScanNowResponse clears scanInFlight", () => {
		clearInstanceState();
		beginScan();
		expect(isScanInFlight()).toBe(true);

		applyScanNowResponse({
			projectSlug: "demo",
			discovered: [4098],
			lost: [],
			active: [4096, 4098],
		});

		expect(isScanInFlight()).toBe(false);
		expect(getScanResult()).toEqual({
			discovered: [4098],
			lost: [],
			active: [4096, 4098],
		});
	});

	it("stores active ports from scan result", () => {
		clearInstanceState();
		beginScan();

		applyScanNowResponse({
			projectSlug: "demo",
			discovered: [],
			lost: [],
			active: [4096, 4097],
		});

		expect(isScanInFlight()).toBe(false);
		const result = getScanResult();
		expect(result).toEqual({
			discovered: [],
			lost: [],
			active: [4096, 4097],
		});
	});
});
