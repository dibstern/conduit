<!-- ─── Setup Page ────────────────────────────────────────────────────────── -->
<!-- Multi-step setup wizard: Tailscale, Certificate, PWA, Push, Done.       -->
<!-- Ported from setupPageHtml() in pages.ts to a Svelte 5 component.        -->
<!-- Step components extracted into components/setup/ for modularity.         -->

<script lang="ts">
	import { onMount } from "svelte";
	import { navigate } from "../stores/router.svelte.js";
	import { HTTPS_VERIFY_TIMEOUT_MS, SETUP_STEP_TRANSITION_MS } from "../ui-constants.js";
	import {
		type PlatformInfo,
		type SetupInfo,
		type StatusVariant,
		detectPlatform,
		detectPushSubscription,
		buildStepList,
		countFutureHttpsSteps,
		pipClass,
	} from "../utils/setup-utils.js";
	import StepTailscale from "../components/setup/StepTailscale.svelte";
	import StepCertificate from "../components/setup/StepCertificate.svelte";
	import StepPwa from "../components/setup/StepPwa.svelte";
	import StepPush from "../components/setup/StepPush.svelte";
	import StepDone from "../components/setup/StepDone.svelte";

	// ─── Props ──────────────────────────────────────────────────────────────
	let {
		initialSetupInfo,
	}: {
		initialSetupInfo?: SetupInfo;
	} = $props();

	// ─── Core state ────────────────────────────────────────────────────────
	let httpsUrl = $state("");
	let httpUrl = $state("");
	let hasCert = $state(false);
	let lanMode = $state(false);
	let loading = $state(true);

	let platform: PlatformInfo = $state({
		isIOS: false,
		isAndroid: false,
		isDesktop: true,
		isStandalone: false,
		isHttps: false,
		isTailscale: false,
		isSafari: false,
		isIPad: false,
	});

	let steps: string[] = $state([]);
	let currentStepIdx = $state(0);
	let currentStep = $derived(steps[currentStepIdx] ?? "done");

	// ─── Step-specific state ───────────────────────────────────────────────
	let tsStatus: StatusVariant = $state("pending");
	let tsMessage = $state("Checking connection...");
	let certStatus: StatusVariant = $state("pending");
	let certMessage = $state("Checking HTTPS connection...");
	let pushStatus: StatusVariant | null = $state(null);
	let pushMessage = $state("");
	let pushEnabled = $state(false);
	let pushNeedsHttps = $state(false);
	let pushBusy = $state(false);

	// ─── Derived: step display info ────────────────────────────────────────
	let stepOffset = $state(0);
	let futureStepCount = $state(0);
	let totalDisplaySteps = $derived(
		Math.max(steps.length - 1, 0) + stepOffset + futureStepCount,
	);
	let currentDisplayIdx = $derived(currentStepIdx + stepOffset);

	// ─── Tailscale URL hint ────────────────────────────────────────────────
	let tailscaleUrlHint = $derived.by(() => {
		if (httpsUrl.includes("100.")) return `Your relay: ${httpsUrl}`;
		if (httpUrl.includes("100.")) return `Your relay: ${httpUrl}`;
		return "";
	});

	// ─── Done link href ────────────────────────────────────────────────────
	let doneLinkHref = $derived.by(() => {
		if (platform.isStandalone || platform.isHttps) return "/";
		return httpsUrl || "/";
	});

	// ─── Build step list and set initial status ────────────────────────────
	function initSteps(hasPushSub: boolean): void {
		const isLocal =
			typeof window !== "undefined" &&
			(location.hostname === "localhost" ||
				location.hostname === "127.0.0.1");

		steps = buildStepList(platform, hasCert, lanMode, hasPushSub);
		futureStepCount = countFutureHttpsSteps(platform, hasCert, lanMode, hasPushSub);

		// Step offset: carry forward completed steps from cert→HTTPS redirect
		// or from PWA standalone re-open.
		if (typeof window !== "undefined") {
			const params = new URLSearchParams(window.location.search);
			const completedParam = params.get("completed");
			if (completedParam) {
				stepOffset = Number.parseInt(completedParam, 10) || 0;
			} else if (
				platform.isStandalone &&
				typeof localStorage !== "undefined" &&
				localStorage.getItem("setup-pending")
			) {
				stepOffset =
					Number.parseInt(
						localStorage.getItem("setup-pending") || "0",
						10,
					) || 0;
			}
		}

		// Save setup-pending for PWA install flow (includes offset from prior steps)
		if (
			steps.includes("pwa") &&
			typeof localStorage !== "undefined"
		) {
			const stepsBeforePwa = steps.indexOf("pwa");
			localStorage.setItem("setup-pending", String(stepsBeforePwa + 1 + stepOffset));
		}

		// Tailscale status
		if (platform.isTailscale) {
			tsStatus = "ok";
			tsMessage = `Connected via Tailscale (${typeof window !== "undefined" ? location.hostname : ""})`;
		} else if (isLocal) {
			tsStatus = "ok";
			tsMessage = "Running locally. Tailscale is optional.";
		} else {
			tsStatus = "warn";
			tsMessage =
				"You are not on a Tailscale network. Install Tailscale and access the relay via your 100.x.x.x IP.";
		}

		// Certificate status
		if (steps.includes("cert")) {
			if (platform.isHttps) {
				certStatus = "ok";
				certMessage = "HTTPS connection verified";
			} else {
				checkHttps();
			}
		}

		// Push: check HTTPS requirement
		if (!platform.isHttps && !isLocal) {
			pushNeedsHttps = true;
		}

		loading = false;
	}

	// ─── Navigation helpers ────────────────────────────────────────────────
	function nextStep(): void {
		// After cert step on HTTP, redirect to HTTPS for remaining steps.
		// Pass completed step count so the HTTPS page continues the numbering.
		if (!platform.isHttps && steps[currentStepIdx] === "cert") {
			const completed = currentStepIdx + 1;
			const params = new URLSearchParams();
			if (lanMode) params.set("mode", "lan");
			params.set("completed", String(completed));
			window.location.replace(`${httpsUrl}/setup?${params.toString()}`);
			return;
		}
		if (currentStepIdx < steps.length - 1) {
			currentStepIdx = currentStepIdx + 1;
		}
	}

	function goToDone(): void {
		if (typeof localStorage !== "undefined") {
			localStorage.removeItem("setup-pending");
			localStorage.setItem("setup-done", "1");
		}
		navigate(doneLinkHref);
	}

	// ─── HTTPS check ──────────────────────────────────────────────────────
	async function checkHttps(): Promise<void> {
		certStatus = "pending";
		certMessage = "Checking HTTPS connection...";

		try {
			const ac = new AbortController();
			const timer = setTimeout(() => ac.abort(), HTTPS_VERIFY_TIMEOUT_MS);
			await fetch(`${httpsUrl}/info`, {
				signal: ac.signal,
				mode: "no-cors",
			});
			clearTimeout(timer);
			certStatus = "ok";
			certMessage = "HTTPS connection verified. Certificate is trusted.";
		} catch {
			certStatus = "warn";
			certMessage =
				"Certificate not trusted yet. Install it above, then retry.";
		}
	}

	// ─── Push notification enable ─────────────────────────────────────────
	async function enablePush(): Promise<void> {
		pushBusy = true;
		pushMessage = "";
		pushStatus = null;

		if (
			typeof window === "undefined" ||
			!("serviceWorker" in navigator) ||
			!("PushManager" in window)
		) {
			pushStatus = "warn";
			pushMessage =
				"Push notifications are not supported in this browser.";
			pushBusy = false;
			return;
		}

		try {
			const { enablePushSubscription } = await import("../utils/notifications.js");
			await enablePushSubscription();

			pushStatus = "ok";
			pushMessage = "Push notifications enabled!";
			pushEnabled = true;

			setTimeout(() => nextStep(), SETUP_STEP_TRANSITION_MS);
		} catch (err: unknown) {
			if (
				typeof Notification !== "undefined" &&
				Notification.permission === "denied"
			) {
				pushStatus = "warn";
				pushMessage =
					"Notification permission was denied. Enable it in browser settings.";
			} else {
				pushStatus = "warn";
				pushMessage = `Could not enable push: ${err instanceof Error ? err.message : "unknown error"}`;
			}
		} finally {
			pushBusy = false;
		}
	}

	// ─── Init ──────────────────────────────────────────────────────────────
	onMount(async () => {
		platform = detectPlatform();

		if (initialSetupInfo) {
			httpsUrl = initialSetupInfo.httpsUrl;
			httpUrl = initialSetupInfo.httpUrl;
			hasCert = initialSetupInfo.hasCert;
			lanMode = initialSetupInfo.lanMode;
		} else {
			try {
				const resp = await fetch("/api/setup-info");
				const info = await resp.json();
				httpsUrl = info.httpsUrl ?? "";
				httpUrl = info.httpUrl ?? "";
				hasCert = !!info.hasCert;
				lanMode = !!info.lanMode;
			} catch {
				// Fallback: use current location
				httpsUrl = location.origin;
				httpUrl = location.origin;
			}
		}

		const hasPushSub = await detectPushSubscription();
		initSteps(hasPushSub);
	});
</script>

{#if loading}
	<div
		class="flex items-center justify-center min-h-dvh bg-bg text-text font-sans"
	>
		<div class="text-text-muted text-sm">Loading setup...</div>
	</div>
{:else}
	<div
		class="min-h-dvh bg-bg text-text font-sans flex justify-center pt-[env(safe-area-inset-top,0)] px-5 pb-10"
	>
		<div class="max-w-[480px] w-full pt-10">
			<!-- Header -->
			<h1 class="text-text text-2xl font-semibold text-center mb-1">
				Conduit
			</h1>
			<p class="text-center text-text-muted text-base mb-7">
				Setup your device for the best experience
			</p>

			<!-- Progress bar -->
			{#if totalDisplaySteps > 1}
				<div class="flex gap-1.5 mb-8">
					{#each Array(totalDisplaySteps) as _, i}
						<div
							class="flex-1 h-[3px] rounded-sm transition-colors duration-300"
						class:bg-success={pipClass(i, currentDisplayIdx) === "done"}
						class:bg-accent={pipClass(i, currentDisplayIdx) === "active"}
						class:bg-border={pipClass(i, currentDisplayIdx) === ""}
						></div>
					{/each}
				</div>
			{/if}

			<!-- ─── Steps ──────────────────────────────────────────────── -->
			{#if currentStep === "tailscale"}
				<StepTailscale
					totalSteps={totalDisplaySteps}
					currentIdx={currentDisplayIdx}
					isIOS={platform.isIOS}
					isAndroid={platform.isAndroid}
					{tailscaleUrlHint}
					{tsStatus}
					{tsMessage}
					onnextstep={nextStep}
				/>
			{/if}

			{#if currentStep === "cert"}
				<StepCertificate
					totalSteps={totalDisplaySteps}
					currentIdx={currentDisplayIdx}
					isIOS={platform.isIOS}
					isAndroid={platform.isAndroid}
					{certStatus}
					{certMessage}
					onnextstep={nextStep}
					onretryhttps={checkHttps}
				/>
			{/if}

			{#if currentStep === "pwa"}
				<StepPwa
					totalSteps={totalDisplaySteps}
					currentIdx={currentDisplayIdx}
					isIOS={platform.isIOS}
					isAndroid={platform.isAndroid}
					isDesktop={platform.isDesktop}
					isSafari={platform.isSafari}
					isIPad={platform.isIPad}
					onnextstep={nextStep}
				/>
			{/if}

			{#if currentStep === "push"}
				<StepPush
					totalSteps={totalDisplaySteps}
					currentIdx={currentDisplayIdx}
					{pushNeedsHttps}
					{pushEnabled}
					{pushBusy}
					{pushStatus}
					{pushMessage}
					onnextstep={nextStep}
					onenablepush={enablePush}
				/>
			{/if}

			{#if currentStep === "done"}
				<StepDone ongotodone={goToDone} />
			{/if}
		</div>
	</div>
{/if}

<style>
	@keyframes fadeIn {
		from {
			opacity: 0;
			transform: translateY(8px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}
	:global(.animate-fadeIn) {
		animation: fadeIn 0.25s ease;
	}
</style>
