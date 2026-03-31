<!--
  NotifSettings — Notification settings dropdown menu.
  Three toggle switches for push notifications, browser alerts, and sound.
  Settings are persisted to localStorage via the shared notif-settings utility.
  Push toggle handles the full subscription lifecycle (SW registration, VAPID
  key fetch, browser subscribe, server registration).
-->
<script lang="ts">
	import ToggleSetting from "../shared/ToggleSetting.svelte";
	import {
		type NotifSettings,
		getNotifSettings,
		saveNotifSettings,
	} from "../../utils/notif-settings.js";
	import { createFrontendLogger } from "../../utils/logger.js";
	import { setPushActive } from "../../stores/ws.svelte.js";

	const pushLog = createFrontendLogger("push");
	const notifLog = createFrontendLogger("notif");

	// ─── Props ──────────────────────────────────────────────────────────────────

	let {
		visible = false,
		onClose,
	}: {
		visible: boolean;
		onClose?: () => void;
	} = $props();

	// ─── State ──────────────────────────────────────────────────────────────────

	let settings: NotifSettings = $state(getNotifSettings());
	let pushBlocked = $state(
		typeof Notification !== "undefined" &&
			Notification.permission === "denied",
	);
	let browserBlocked = $state(
		typeof Notification !== "undefined" &&
			Notification.permission === "denied",
	);
	let pushBusy = $state(false);
	let pushError = $state("");

	// Push requires a secure context (HTTPS or localhost) and Notification API
	const pushUnavailable =
		typeof Notification === "undefined" ||
		!("serviceWorker" in navigator) ||
		(typeof window !== "undefined" && !window.isSecureContext);

	// ─── Handlers ───────────────────────────────────────────────────────────────

	async function togglePush(): Promise<void> {
		if (pushBusy) return;
		pushBusy = true;
		pushError = "";
		try {
			if (!settings.push) {
				// ── Enable push ──────────────────────────────────────────────
				if (pushUnavailable) {
					pushError =
						"Push notifications require a secure connection (HTTPS).";
					return;
				}

				const permission = await Notification.requestPermission();
				pushBlocked = permission === "denied";
				if (permission !== "granted") return;

				const { enablePushSubscription } = await import(
					"../../utils/notifications.js"
				);
				await enablePushSubscription();

				settings.push = true;
				saveNotifSettings(settings);
				setPushActive(true);

				// Show a confirmation notification via the SW — validates the
				// full push path end-to-end.
				try {
					const swReg = await navigator.serviceWorker.getRegistration();
					if (swReg?.active) {
						await swReg.showNotification("Push Enabled", {
							body: "Push notifications are now active on this device.",
							tag: "opencode-push-enabled",
						});
					}
				} catch {
					// Non-fatal
				}
			} else {
				// ── Disable push ─────────────────────────────────────────────
				// Flip the flags synchronously FIRST so browser alerts resume
				// immediately — don't wait for the async cleanup below.
				settings.push = false;
				saveNotifSettings(settings);
				setPushActive(false);

				// Use getRegistration() — never hangs, unlike .ready which
				// blocks forever if the SW was evicted by the OS.
				const swReg =
					await navigator.serviceWorker.getRegistration();

				if (swReg?.active) {
					// Confirm via the SW before cleanup
					try {
						await swReg.showNotification("Push Disabled", {
							body: "Browser alerts will be used instead.",
							tag: "opencode-push-disabled",
						});
					} catch {
						// Non-fatal
					}

					// Unsubscribe from push — but keep the SW registered so
					// re-enabling doesn't require a full re-registration cycle
					// (which fails on some browsers, especially iOS).
					const sub =
						await swReg.pushManager.getSubscription();
					if (sub) {
						const endpoint = sub.endpoint;
						await sub.unsubscribe();
						await fetch("/api/push/unsubscribe", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ endpoint }),
						});
					}
				}
			}
		} catch (err) {
			pushLog.warn("Toggle failed:", err);
			settings.push = false;
			setPushActive(false);
			pushError =
				err instanceof Error
					? err.message
					: "Push notification setup failed. Please try again.";
		} finally {
			saveNotifSettings(settings);
			pushBusy = false;
		}
	}

	async function toggleBrowser(): Promise<void> {
		const newValue = !settings.browser;

		if (newValue && typeof Notification !== "undefined") {
			if (Notification.permission === "denied") {
				// Already permanently blocked — show hint, don't change setting
				browserBlocked = true;
				return;
			}
			if (Notification.permission !== "granted") {
				const perm = await Notification.requestPermission();
				browserBlocked = perm === "denied";
				if (perm !== "granted") return;
			}
			// Test notification — verifies the Notification API works on this OS
			try {
				const n = new Notification("Browser Alerts Enabled", {
					body: "You will be notified when tasks complete.",
					tag: "opencode-browser-test",
				});
				setTimeout(() => n.close(), 5000);
			} catch (err) {
				notifLog.warn("Test notification failed:", err);
			}
		}

		settings.browser = newValue;
		saveNotifSettings(settings);
	}

	function toggleSound(): void {
		settings.sound = !settings.sound;
		saveNotifSettings(settings);
	}

	function handleBackdropClick(): void {
		onClose?.();
	}

	function handleKeydown(e: KeyboardEvent): void {
		if (e.key === "Escape") {
			onClose?.();
		}
	}
</script>

<svelte:window onkeydown={visible ? handleKeydown : undefined} />

{#if visible}
	<!-- Invisible backdrop for outside-click detection -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="fixed inset-0 z-40" onclick={handleBackdropClick}></div>

	<!-- Dropdown menu (opens upward, fixed to sidebar bottom-left like ThemePicker) -->
	<div
		class="fixed bottom-[56px] left-2 w-[240px] bg-bg-alt border border-border rounded-lg shadow-xl z-[1000] py-1.5 overflow-hidden"
	>
		<ToggleSetting
			icon="smartphone"
			label="Push notifications"
			checked={settings.push}
			onchange={togglePush}
			disabled={pushBusy || pushUnavailable}
			dimmed={pushUnavailable}
		/>

		<ToggleSetting
			icon="bell"
			label="Browser alerts"
			checked={settings.browser}
			onchange={toggleBrowser}
		/>

		<ToggleSetting
			icon="volume-2"
			label="Sound"
			checked={settings.sound}
			onchange={toggleSound}
		/>

		<!-- Error / blocked hints -->
		{#if pushUnavailable}
			<div
				class="notif-blocked px-3.5 py-2 text-xs text-text-muted border-t border-border mt-1"
			>
				Push notifications require HTTPS. Enable a certificate in the
				CLI settings.
			</div>
		{:else if pushError}
			<div
				class="notif-blocked px-3.5 py-2 text-xs text-error border-t border-border mt-1"
			>
				{pushError}
			</div>
		{:else if pushBlocked}
			<div
				class="notif-blocked px-3.5 py-2 text-xs text-error border-t border-border mt-1"
			>
				Push notifications are blocked by your browser. Update your
				site settings to allow notifications.
			</div>
		{:else if browserBlocked}
			<div
				class="notif-blocked px-3.5 py-2 text-xs text-error border-t border-border mt-1"
			>
				Browser alerts are blocked. Update your site settings to allow
				notifications.
			</div>
		{/if}
	</div>
{/if}
