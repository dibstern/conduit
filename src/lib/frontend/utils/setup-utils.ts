// ─── Setup Utilities ─────────────────────────────────────────────────────────
// Extracted from SetupPage.svelte — platform detection and push subscription
// helpers used by the setup wizard.

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PlatformInfo {
	isIOS: boolean;
	isAndroid: boolean;
	isDesktop: boolean;
	isStandalone: boolean;
	isHttps: boolean;
	isTailscale: boolean;
	isSafari: boolean;
	isIPad: boolean;
}

export interface SetupInfo {
	httpsUrl: string;
	httpUrl: string;
	hasCert: boolean;
	lanMode: boolean;
}

export type StatusVariant = "ok" | "warn" | "pending";

// ─── Platform detection ─────────────────────────────────────────────────────

export function detectPlatform(): PlatformInfo {
	if (typeof window === "undefined") {
		return {
			isIOS: false,
			isAndroid: false,
			isDesktop: true,
			isStandalone: false,
			isHttps: false,
			isTailscale: false,
			isSafari: false,
			isIPad: false,
		};
	}

	const ua = navigator.userAgent;
	const isIOS = /iPhone|iPad|iPod/.test(ua);
	const isAndroid = /Android/i.test(ua);
	const isDesktop = !isIOS && !isAndroid;
	const isStandalone =
		window.matchMedia("(display-mode:standalone)").matches ||
		!!(navigator as Navigator & { standalone?: boolean }).standalone;
	const isHttps = location.protocol === "https:";
	const isTailscale = /^100\./.test(location.hostname);
	const isIPad =
		/iPad/.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
	const isSafari =
		isIOS && /Safari/.test(ua) && !/CriOS|FxiOS|OPiOS|EdgiOS/.test(ua);

	return {
		isIOS,
		isAndroid,
		isDesktop,
		isStandalone,
		isHttps,
		isTailscale,
		isSafari,
		isIPad,
	};
}

// ─── Push subscription detection ────────────────────────────────────────────

export async function detectPushSubscription(): Promise<boolean> {
	if (typeof window === "undefined") return false;
	const isLocal =
		location.hostname === "localhost" || location.hostname === "127.0.0.1";
	if (
		!("serviceWorker" in navigator) ||
		(!location.protocol.startsWith("https") && !isLocal)
	)
		return false;
	if (!navigator.serviceWorker.controller) return false;
	try {
		const reg = await navigator.serviceWorker.ready;
		const sub = await reg.pushManager.getSubscription();
		return !!sub;
	} catch {
		return false;
	}
}

// ─── Step list builder ──────────────────────────────────────────────────────

export function buildStepList(
	platform: PlatformInfo,
	hasCert: boolean,
	lanMode: boolean,
	hasPushSub: boolean,
): string[] {
	const isLocal =
		typeof window !== "undefined" &&
		(location.hostname === "localhost" || location.hostname === "127.0.0.1");
	const newSteps: string[] = [];

	if (!platform.isTailscale && !isLocal && !lanMode) newSteps.push("tailscale");
	if (hasCert && !platform.isHttps) newSteps.push("cert");

	if (platform.isAndroid) {
		if ((platform.isHttps || isLocal) && !hasPushSub) newSteps.push("push");
		if (!platform.isStandalone) newSteps.push("pwa");
	} else {
		if (!platform.isStandalone) newSteps.push("pwa");
		if ((platform.isHttps || isLocal) && !hasPushSub) newSteps.push("push");
	}
	newSteps.push("done");

	return newSteps;
}

// ─── Future step count (HTTP → HTTPS redirect) ─────────────────────────
// When the setup wizard runs on the HTTP onboarding page (hasCert &&
// !isHttps), some steps (like "push") won't appear because they require
// HTTPS.  After the cert step redirects to HTTPS, buildStepList() will
// include those steps.  This function counts how many *extra* steps the
// HTTPS page will add so the HTTP page can show the correct total.

export function countFutureHttpsSteps(
	platform: PlatformInfo,
	hasCert: boolean,
	lanMode: boolean,
	hasPushSub: boolean,
): number {
	if (!hasCert || platform.isHttps) return 0;

	// Simulate what the HTTPS page will build
	const httpsPlat = { ...platform, isHttps: true };
	const httpsSteps = buildStepList(httpsPlat, hasCert, lanMode, hasPushSub);
	const httpSteps = buildStepList(platform, hasCert, lanMode, hasPushSub);

	// The HTTPS list won't have "cert" but may gain "push".
	// Count steps in HTTPS list that aren't in HTTP list (excluding "done").
	const httpSet = new Set(httpSteps);
	return httpsSteps.filter((s) => s !== "done" && !httpSet.has(s)).length;
}

// ─── Progress pip class ─────────────────────────────────────────────────────

export function pipClass(
	i: number,
	currentDisplayIdx: number,
): "done" | "active" | "" {
	if (i < currentDisplayIdx) return "done";
	if (i === currentDisplayIdx) return "active";
	return "";
}
