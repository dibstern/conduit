<script lang="ts">
	import Toggle from "../ui/Toggle.svelte";
	import { createFrontendLogger } from "../../utils/logger.js";
	import { saveNotifSettings, type NotifSettings } from "../../utils/notif-settings.js";
	import { setPushActive } from "../../stores/ws.svelte.js";
	const log = createFrontendLogger("push");
	let { state = $bindable() }: { state: {
		notifSettings: NotifSettings;
		pushBlocked: boolean;
		browserBlocked: boolean;
		pushBusy: boolean;
		pushError: string;
	}} = $props();
	const pushUnavailable =
		typeof Notification === "undefined" ||
		!("serviceWorker" in navigator) ||
		(typeof window !== "undefined" && !window.isSecureContext);
	async function togglePush(): Promise<void> {
		if (state.pushBusy) return;
		state.pushBusy = true;
		state.pushError = "";
		try {
			if (!state.notifSettings.push) {
				if (pushUnavailable) { state.pushError = "Push notifications require a secure connection (HTTPS)."; return; }
				const permission = await Notification.requestPermission();
				state.pushBlocked = permission === "denied";
				if (permission !== "granted") return;
				const { enablePushSubscription } = await import("../../utils/notifications.js");
				await enablePushSubscription();
				state.notifSettings.push = true;
				saveNotifSettings(state.notifSettings);
				setPushActive(true);
				try {
					const swReg = await navigator.serviceWorker.getRegistration();
					if (swReg?.active) await swReg.showNotification("Push Enabled", { body: "Push notifications are now active.", tag: "opencode-push-enabled" });
				} catch { /* non-fatal */ }
			} else {
				state.notifSettings.push = false;
				saveNotifSettings(state.notifSettings);
				setPushActive(false);
				// Use getRegistration() — never hangs, unlike .ready which
				// blocks forever if the SW was evicted by the OS.
				const swReg = await navigator.serviceWorker.getRegistration();
				if (swReg?.active) {
					try { await swReg.showNotification("Push Disabled", { body: "Browser alerts will be used instead.", tag: "opencode-push-disabled" }); } catch { /* non-fatal */ }
					const sub = await swReg.pushManager.getSubscription();
					if (sub) {
						const endpoint = sub.endpoint;
						await sub.unsubscribe();
						await fetch("/api/push/unsubscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint }) });
					}
				}
			}
		} catch (err) {
			log.warn("Toggle failed:", err);
			state.notifSettings.push = false;
			setPushActive(false);
			state.pushError = err instanceof Error ? err.message : "Push notification setup failed.";
		} finally {
			saveNotifSettings(state.notifSettings);
			state.pushBusy = false;
		}
	}
	async function toggleBrowser(): Promise<void> {
		const newValue = !state.notifSettings.browser;
		if (newValue && typeof Notification !== "undefined") {
			if (Notification.permission === "denied") { state.browserBlocked = true; return; }
			if (Notification.permission !== "granted") {
				const perm = await Notification.requestPermission();
				state.browserBlocked = perm === "denied";
				if (perm !== "granted") return;
			}
			try { const notification = new Notification("Browser Alerts Enabled", { body: "You will be notified when tasks complete.", tag: "opencode-browser-test" }); setTimeout(() => notification.close(), 5000); } catch { /* */ }
		}
		state.notifSettings.browser = newValue;
		saveNotifSettings(state.notifSettings);
	}
	function toggleSound(): void {
		state.notifSettings.sound = !state.notifSettings.sound;
		saveNotifSettings(state.notifSettings);
	}
</script>

<Toggle
	label="Push notifications"
	description="Receive push notifications even when the tab is closed"
	checked={state.notifSettings.push}
	onchange={togglePush}
	disabled={state.pushBusy || pushUnavailable}
/>
<Toggle
	label="Browser alerts"
	description="Show desktop notifications when tasks complete"
	checked={state.notifSettings.browser}
	onchange={toggleBrowser}
/>
<Toggle
	label="Sound"
	description="Play a sound when notifications are triggered"
	checked={state.notifSettings.sound}
	onchange={toggleSound}
/>
{#if pushUnavailable}
	<p class="text-text-dimmer">Push notifications require HTTPS. Enable a certificate in the CLI settings.</p>
{:else if state.pushError}
	<p class="text-error">{state.pushError}</p>
{:else if state.pushBlocked}
	<p class="text-error">Push notifications are blocked by your browser. Update site settings to allow notifications.</p>
{:else if state.browserBlocked}
	<p class="text-error">Browser alerts are blocked. Update site settings to allow notifications.</p>
{/if}
