// ─── Setup Utilities — Unit Tests ─────────────────────────────────────────────
// Tests buildStepList, countFutureHttpsSteps, pipClass, detectPlatform.

import { describe, expect, test } from "vitest";
import {
	buildStepList,
	countFutureHttpsSteps,
	type PlatformInfo,
	pipClass,
} from "../../../src/lib/frontend/utils/setup-utils.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makePlatform(overrides: Partial<PlatformInfo> = {}): PlatformInfo {
	return {
		isIOS: false,
		isAndroid: false,
		isDesktop: true,
		isStandalone: false,
		isHttps: false,
		isTailscale: false,
		isSafari: false,
		isIPad: false,
		...overrides,
	};
}

// ─── buildStepList ──────────────────────────────────────────────────────────

describe("buildStepList", () => {
	// Use isTailscale: true in tests that don't test the tailscale step,
	// because in Node (no window), isLocal=false → tailscale step appears.

	test("HTTPS desktop (tailscale): pwa, push, done", () => {
		const steps = buildStepList(
			makePlatform({ isHttps: true, isTailscale: true }),
			true,
			false,
			false,
		);
		expect(steps).toEqual(["pwa", "push", "done"]);
	});

	test("HTTP with cert (onboarding page, tailscale): cert, pwa, done (no push)", () => {
		const steps = buildStepList(
			makePlatform({ isHttps: false, isTailscale: true }),
			true,
			false,
			false,
		);
		expect(steps).toEqual(["cert", "pwa", "done"]);
	});

	test("HTTPS standalone with push (tailscale): just done", () => {
		const steps = buildStepList(
			makePlatform({ isHttps: true, isStandalone: true, isTailscale: true }),
			true,
			false,
			true,
		);
		expect(steps).toEqual(["done"]);
	});

	test("non-tailscale, non-local, non-lan: includes tailscale step", () => {
		// In Node, window is undefined → isLocal=false
		const steps = buildStepList(
			makePlatform({ isHttps: true, isTailscale: false }),
			true,
			false,
			false,
		);
		expect(steps[0]).toBe("tailscale");
	});

	test("tailscale network: no tailscale step", () => {
		const steps = buildStepList(
			makePlatform({ isHttps: true, isTailscale: true }),
			true,
			false,
			false,
		);
		expect(steps).not.toContain("tailscale");
	});

	test("lan mode: no tailscale step", () => {
		const steps = buildStepList(
			makePlatform({ isHttps: true }),
			true,
			true,
			false,
		);
		expect(steps).not.toContain("tailscale");
	});

	test("Android HTTPS (tailscale): push before pwa", () => {
		const steps = buildStepList(
			makePlatform({
				isAndroid: true,
				isDesktop: false,
				isHttps: true,
				isTailscale: true,
			}),
			true,
			false,
			false,
		);
		const pushIdx = steps.indexOf("push");
		const pwaIdx = steps.indexOf("pwa");
		expect(pushIdx).toBeGreaterThanOrEqual(0);
		expect(pwaIdx).toBeGreaterThanOrEqual(0);
		expect(pushIdx).toBeLessThan(pwaIdx);
	});

	test("no cert: no cert step", () => {
		const steps = buildStepList(
			makePlatform({ isHttps: false, isTailscale: true }),
			false,
			false,
			false,
		);
		expect(steps).not.toContain("cert");
	});
});

// ─── countFutureHttpsSteps ──────────────────────────────────────────────────

describe("countFutureHttpsSteps", () => {
	test("returns 0 when already on HTTPS", () => {
		const count = countFutureHttpsSteps(
			makePlatform({ isHttps: true, isTailscale: true }),
			true,
			false,
			false,
		);
		expect(count).toBe(0);
	});

	test("returns 0 when no cert", () => {
		const count = countFutureHttpsSteps(
			makePlatform({ isHttps: false, isTailscale: true }),
			false,
			false,
			false,
		);
		expect(count).toBe(0);
	});

	test("returns 1 on HTTP with cert (push will appear after redirect)", () => {
		// HTTP steps: cert, pwa, done
		// HTTPS steps: pwa, push, done
		// Future steps not in HTTP: push → 1
		const count = countFutureHttpsSteps(
			makePlatform({ isHttps: false, isTailscale: true }),
			true,
			false,
			false,
		);
		expect(count).toBe(1);
	});

	test("returns 0 on HTTP with cert when push already subscribed", () => {
		// HTTP steps: cert, pwa, done
		// HTTPS steps: pwa, done (push already subscribed)
		// Future steps not in HTTP: none → 0
		const count = countFutureHttpsSteps(
			makePlatform({ isHttps: false, isTailscale: true }),
			true,
			false,
			true,
		);
		expect(count).toBe(0);
	});

	test("HTTP Android with cert: push will appear after redirect", () => {
		// HTTP Android: cert, pwa, done (push excluded because !isHttps)
		// HTTPS Android: push, pwa, done
		// Future steps not in HTTP: push → 1
		const count = countFutureHttpsSteps(
			makePlatform({
				isAndroid: true,
				isDesktop: false,
				isHttps: false,
				isTailscale: true,
			}),
			true,
			false,
			false,
		);
		expect(count).toBe(1);
	});
});

// ─── pipClass ───────────────────────────────────────────────────────────────

describe("pipClass", () => {
	test("returns 'done' for steps before current", () => {
		expect(pipClass(0, 2)).toBe("done");
		expect(pipClass(1, 2)).toBe("done");
	});

	test("returns 'active' for current step", () => {
		expect(pipClass(2, 2)).toBe("active");
	});

	test("returns empty string for future steps", () => {
		expect(pipClass(3, 2)).toBe("");
		expect(pipClass(4, 2)).toBe("");
	});
});
