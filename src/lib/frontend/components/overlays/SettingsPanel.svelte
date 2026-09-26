<!-- ─── Settings Panel ────────────────────────────────────────────────────── -->
<!-- Modal settings panel with tabbed navigation. Uses the 68-mockup card   -->
<!-- design. Tabs: Notifications, Appearance, Agents & Models, Claude,      -->
<!-- Instances, Debug.                                                      -->

<script lang="ts">
	import Modal from "./Modal.svelte";
	import { untrack } from "svelte";
	import Button from "../ui/Button.svelte";
	import Badge from "../ui/Badge.svelte";
	import Icon from "../ui/Icon.svelte";
	import Checkbox from "../ui/Checkbox.svelte";
	import Select from "../ui/Select.svelte";
	import Textarea from "../ui/Textarea.svelte";
	import TextInput from "../ui/TextInput.svelte";
	import Toggle from "../ui/Toggle.svelte";
	import Surface from "../ui/Surface.svelte";
	import Tabs from "../ui/Tabs.svelte";
	import SegmentedControl from "../ui/SegmentedControl.svelte";
	import Disclosure from "../ui/Disclosure.svelte";
	import ClaudeSettingsTab from "./ClaudeSettingsTab.svelte";
	import { createFrontendLogger } from "../../utils/logger.js";

	const log = createFrontendLogger("push");
	import {
		applyDetectProxyResponse,
		applyInstanceListResponse,
		applyScanNowResponse,
		beginProxyDetection,
		beginScan,
		clearScanInFlight,
		getCachedInstances,
		getProxyDetection,
		getScanResult,
		instanceStatusColor,
		isScanInFlight,
	} from "../../stores/instance.svelte.js";
	import { confirm, showToast } from "../../stores/ui.svelte.js";
	import {
		applyGetAgentsResponse,
		applyGetModelsResponse,
		discoveryState,
	} from "../../stores/discovery.svelte.js";
	import { copyToClipboard } from "../../utils/clipboard.js";
	import { featureFlags, toggleFeature } from "../../stores/feature-flags.svelte.js";
	import {
		themeState,
		setThemeMode,
		type ThemeMode,
	} from "../../stores/theme.svelte.js";
	import {
		type NotifSettings,
		getNotifSettings,
		saveNotifSettings,
	} from "../../utils/notif-settings.js";
	import { setPushActive } from "../../stores/ws.svelte.js";
	import { clearClaudeSettingEdits } from "../../stores/claude-settings.svelte.js";
	import { getCurrentSlug } from "../../stores/router.svelte.js";
	import TextButton from "../ui/TextButton.svelte";
	import {
		addInstanceRpc,
		detectProxyRpc,
		getAgentsRpc,
		getAutoSettleSettingRpc,
		getModelsRpc,
		removeInstanceRpc,
		renameInstanceRpc,
		scanNowRpc,
		setHiddenEntriesRpc,
		startInstanceRpc,
		setAutoSettleSettingRpc,
		stopInstanceRpc,
		updateInstanceRpc,
	} from "../../transport/ws-rpc-client.js";

	// ─── Props ──────────────────────────────────────────────────────────────

	let {
		visible = false,
		initialTab = "notifications",
		onClose,
	}: { visible: boolean; initialTab?: string; onClose?: () => void } =
		$props();

	// ─── Local state ────────────────────────────────────────────────────────

	let activeTab = $state("notifications");
	let autoSettleDays = $state<number | null>(3);
	let autoSettleSaving = $state(false);

	// Instance management
	let expandedInstanceId = $state<string | null>(null);
	let renamingInstanceId = $state<string | null>(null);
	let renameValue = $state("");
	let expandedScenario = $state<string | null>(null);
	let copiedKey = $state<string | null>(null);
	let copyTimer: ReturnType<typeof setTimeout> | null = null;

	// Named-instance editor (add/edit a provider instance)
	let instanceFormMode = $state<"add" | "edit" | null>(null);
	let editingInstanceId = $state<string | null>(null);
	let formDriver = $state<"claude" | "opencode">("opencode");
	let formName = $state("");
	let formConfigDir = $state("");
	let formManaged = $state(false);
	let formPort = $state("");
	let formUrl = $state("");
	let formEnv = $state("");
	let formSaving = $state(false);
	const DRIVER_OPTIONS = ["opencode", "claude"] as const;

	/**
	 * Hoisted out of the template so the array identity is stable across
	 * renders; an inline literal would be a new array every time `activeTab`
	 * changed, re-keying the whole strip on every tab click.
	 */
	const SETTINGS_TABS = [
		{ value: "notifications", label: "Alerts", testId: "settings-tab-notifications" },
		{ value: "appearance", label: "Theme", testId: "settings-tab-appearance" },
		{ value: "visibility", label: "Agents & Models", testId: "settings-tab-visibility" },
		{ value: "claude", label: "Claude", testId: "settings-tab-claude" },
		{ value: "instances", label: "Instances", testId: "settings-tab-instances" },
		{ value: "debug", label: "Debug", testId: "settings-tab-debug" },
	];

	const DRIVER_TAB_OPTIONS = DRIVER_OPTIONS.map((driver) => ({
		value: driver,
		label: driver === "claude" ? "Claude" : "OpenCode",
		testId: `instance-form-driver-${driver}`,
	}));

	// Notification settings
	let notifSettings: NotifSettings = $state(getNotifSettings());
	let pushBlocked = $state(
		typeof Notification !== "undefined" && Notification.permission === "denied",
	);
	let browserBlocked = $state(
		typeof Notification !== "undefined" && Notification.permission === "denied",
	);
	let pushBusy = $state(false);
	let pushError = $state("");
	const pushUnavailable =
		typeof Notification === "undefined" ||
		!("serviceWorker" in navigator) ||
		(typeof window !== "undefined" && !window.isSecureContext);

	// ─── Derived ────────────────────────────────────────────────────────────

	const instances = $derived(getCachedInstances());
	const scanInFlight = $derived(isScanInFlight());
	const scanResult = $derived(getScanResult());
	const proxyResult = $derived(getProxyDetection());
	const ccsDetected = $derived(proxyResult?.found ?? false);
	// ─── Effects ────────────────────────────────────────────────────────────

	$effect(() => {
		if (visible) {
			void getAutoSettleSettingRpc()
				.then((days) => {
					autoSettleDays = days;
				})
				.catch(() => {
					showToast("Couldn't load auto-settle setting", { variant: "error" });
				});
			clearClaudeSettingEdits();
			activeTab = initialTab;
			expandedInstanceId = null;
			renamingInstanceId = null;
			expandedScenario = null;
			closeInstanceForm();
			// Only refresh notification settings if no toggle operation is
			// in progress. Reading pushBusy via untrack() avoids adding it
			// as a dependency (which would re-trigger this effect when the
			// toggle completes and cause the exact race we're preventing).
			if (!untrack(() => pushBusy)) {
				notifSettings = getNotifSettings();
			}
			const projectSlug = getCurrentSlug();
			if (projectSlug) {
				beginProxyDetection();
				void detectProxyRpc({ projectSlug })
					.then(applyDetectProxyResponse)
					.catch(() =>
						applyDetectProxyResponse({
							projectSlug,
							found: false,
							port: 8317,
						}),
					);
			}
		} else {
			clearClaudeSettingEdits();
		}
	});

	// ─── Instance handlers ──────────────────────────────────────────────────

	function getRpcProjectSlug(): string | null {
		const slug = getCurrentSlug();
		if (!slug) {
			showToast("No active project connection", { variant: "warn" });
			return null;
		}
		return slug;
	}

	function handleToggleInstance(instanceId: string) {
		expandedInstanceId = expandedInstanceId === instanceId ? null : instanceId;
		if (expandedInstanceId !== instanceId) renamingInstanceId = null;
	}
	function handleStart(instanceId: string) {
		const projectSlug = getRpcProjectSlug();
		if (!projectSlug) return;
		void startInstanceRpc({ projectSlug, instanceId })
			.then(applyInstanceListResponse)
			.catch(() => showToast("Failed to start instance", { variant: "warn" }));
	}
	function handleStop(instanceId: string) {
		const projectSlug = getRpcProjectSlug();
		if (!projectSlug) return;
		void stopInstanceRpc({ projectSlug, instanceId })
			.then(applyInstanceListResponse)
			.catch(() => showToast("Failed to stop instance", { variant: "warn" }));
	}
	async function handleRemove(instanceId: string, instanceName: string) {
		const confirmed = await confirm(`Remove instance "${instanceName}"? This cannot be undone.`);
		if (confirmed) {
			const projectSlug = getRpcProjectSlug();
			if (!projectSlug) return;
			void removeInstanceRpc({ projectSlug, instanceId })
				.then(applyInstanceListResponse)
				.catch(() =>
					showToast("Failed to remove instance", { variant: "warn" }),
				);
		}
	}
	function instanceDriver(inst: { driver?: string }): "claude" | "opencode" {
		return inst.driver === "claude" ? "claude" : "opencode";
	}
	function closeInstanceForm() {
		instanceFormMode = null;
		editingInstanceId = null;
		formDriver = "opencode";
		formName = "";
		formConfigDir = "";
		formManaged = false;
		formPort = "";
		formUrl = "";
		formEnv = "";
		formSaving = false;
	}
	function openAddInstance(driver: "claude" | "opencode" = "opencode") {
		closeInstanceForm();
		instanceFormMode = "add";
		formDriver = driver;
	}
	function openEditInstance(inst: {
		id: string;
		name: string;
		driver?: string;
		port?: number;
		configDir?: string;
		managed?: boolean;
		env?: Record<string, string>;
	}) {
		expandedInstanceId = null;
		instanceFormMode = "edit";
		editingInstanceId = inst.id;
		formDriver = instanceDriver(inst);
		formName = inst.name;
		formConfigDir = inst.configDir ?? "";
		formManaged = inst.managed ?? false;
		formPort = inst.port ? String(inst.port) : "";
		formUrl = "";
		formEnv = inst.env
			? Object.entries(inst.env)
					.map(([k, v]) => `${k}=${v}`)
					.join("\n")
			: "";
	}
	/** Parse `KEY=VALUE` lines into an env record; blank/`#` lines are ignored. */
	function parseEnv(text: string): Record<string, string> | undefined {
		const env: Record<string, string> = {};
		for (const line of text.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;
			const eq = trimmed.indexOf("=");
			if (eq <= 0) continue;
			env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
		}
		return Object.keys(env).length > 0 ? env : undefined;
	}
	function submitInstanceForm() {
		const name = formName.trim();
		if (!name) {
			showToast("Instance name is required", { variant: "warn" });
			return;
		}
		const projectSlug = getRpcProjectSlug();
		if (!projectSlug) return;
		const isClaude = formDriver === "claude";
		const port = formPort.trim() ? Number(formPort.trim()) : undefined;
		if (!isClaude && port !== undefined && !Number.isInteger(port)) {
			showToast("Port must be a whole number", { variant: "warn" });
			return;
		}
		const env = isClaude ? undefined : parseEnv(formEnv);
		const configDir = formConfigDir.trim() || undefined;
		const url = formUrl.trim() || undefined;
		formSaving = true;
		const request =
			instanceFormMode === "edit" && editingInstanceId
				? updateInstanceRpc({
						projectSlug,
						instanceId: editingInstanceId,
						name,
						...(isClaude
							? { ...(configDir !== undefined ? { configDir } : {}) }
							: {
									...(port !== undefined ? { port } : {}),
									...(env !== undefined ? { env } : {}),
								}),
					})
				: addInstanceRpc({
						projectSlug,
						name,
						driver: formDriver,
						...(isClaude
							? {
									managed: false,
									...(configDir !== undefined ? { configDir } : {}),
								}
							: {
									managed: formManaged,
									...(port !== undefined ? { port } : {}),
									...(url !== undefined ? { url } : {}),
									...(env !== undefined ? { env } : {}),
								}),
					});
		void request
			.then((response) => {
				applyInstanceListResponse(response);
				closeInstanceForm();
			})
			.catch(() => {
				formSaving = false;
				showToast(
					`Failed to ${instanceFormMode === "edit" ? "update" : "add"} instance`,
					{ variant: "warn" },
				);
			});
	}
	function handleScanNow() {
		const projectSlug = getRpcProjectSlug();
		if (!projectSlug) return;
		beginScan();
		void scanNowRpc({ projectSlug })
			.then(applyScanNowResponse)
			.catch(() => {
				clearScanInFlight();
				showToast("Port scan failed", { variant: "warn" });
			});
	}
	function startRename(instanceId: string, currentName: string) {
		renamingInstanceId = instanceId;
		renameValue = currentName;
	}
	function submitRename() {
		if (!renamingInstanceId) return;
		const trimmed = renameValue.trim();
		if (!trimmed) { showToast("Instance name cannot be empty", { variant: "warn" }); return; }
		const projectSlug = getRpcProjectSlug();
		if (!projectSlug) return;
		void renameInstanceRpc({
			projectSlug,
			instanceId: renamingInstanceId,
			name: trimmed,
		})
			.then(applyInstanceListResponse)
			.catch(() => showToast("Failed to rename instance", { variant: "warn" }));
		renamingInstanceId = null;
	}
	function cancelRename() { renamingInstanceId = null; }
	function handleRenameKeydown(e: KeyboardEvent) {
		if (e.key === "Enter") { e.preventDefault(); submitRename(); }
		else if (e.key === "Escape") { e.preventDefault(); cancelRename(); }
	}
	async function handleCopy(text: string, key: string) {
		const ok = await copyToClipboard(text);
		if (ok) {
			copiedKey = key;
			if (copyTimer) clearTimeout(copyTimer);
			copyTimer = setTimeout(() => { copiedKey = null; copyTimer = null; }, 2000);
		} else { showToast("Failed to copy — clipboard unavailable", { variant: "warn" }); }
	}
	function toggleScenario(id: string) { expandedScenario = expandedScenario === id ? null : id; }

	// ─── Notification handlers ──────────────────────────────────────────────

	async function togglePush(): Promise<void> {
		if (pushBusy) return;
		pushBusy = true;
		pushError = "";
		try {
			if (!notifSettings.push) {
				if (pushUnavailable) { pushError = "Push notifications require a secure connection (HTTPS)."; return; }
				const permission = await Notification.requestPermission();
				pushBlocked = permission === "denied";
				if (permission !== "granted") return;
				const { enablePushSubscription } = await import("../../utils/notifications.js");
				await enablePushSubscription();
				notifSettings.push = true;
				saveNotifSettings(notifSettings);
				setPushActive(true);
				try {
					const swReg = await navigator.serviceWorker.getRegistration();
					if (swReg?.active) await swReg.showNotification("Push Enabled", { body: "Push notifications are now active.", tag: "opencode-push-enabled" });
				} catch { /* non-fatal */ }
			} else {
				notifSettings.push = false;
				saveNotifSettings(notifSettings);
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
			notifSettings.push = false;
			setPushActive(false);
			pushError = err instanceof Error ? err.message : "Push notification setup failed.";
		} finally {
			saveNotifSettings(notifSettings);
			pushBusy = false;
		}
	}
	async function toggleBrowser(): Promise<void> {
		const newValue = !notifSettings.browser;
		if (newValue && typeof Notification !== "undefined") {
			if (Notification.permission === "denied") { browserBlocked = true; return; }
			if (Notification.permission !== "granted") {
				const perm = await Notification.requestPermission();
				browserBlocked = perm === "denied";
				if (perm !== "granted") return;
			}
			try { const n = new Notification("Browser Alerts Enabled", { body: "You will be notified when tasks complete.", tag: "opencode-browser-test" }); setTimeout(() => n.close(), 5000); } catch { /* */ }
		}
		notifSettings.browser = newValue;
		saveNotifSettings(notifSettings);
	}
	function toggleSound(): void {
		notifSettings.sound = !notifSettings.sound;
		saveNotifSettings(notifSettings);
	}

	// ─── Agents & Models visibility ─────────────────────────────────────────

	const hiddenModelSet = $derived(new Set(discoveryState.hiddenModels));
	const hiddenAgentSet = $derived(new Set(discoveryState.hiddenAgents));
	const agentScopeId = $derived(discoveryState.agentProviderScope?.id ?? null);
	const modelProviders = $derived(
		discoveryState.providers.filter((p) => p.models.length > 0),
	);
	let modelsFetchPending = $state(false);

	// Lazy-load lists when the tab opens with empty discovery state.
	$effect(() => {
		if (!visible || activeTab !== "visibility") return;
		const projectSlug = getCurrentSlug();
		if (!projectSlug) return;
		if (discoveryState.providers.length === 0) {
			modelsFetchPending = true;
			void getModelsRpc({ projectSlug })
				.then(applyGetModelsResponse)
				.catch((err) => log.warn("Visibility models fetch failed:", err))
				.finally(() => {
					modelsFetchPending = false;
				});
		}
		if (discoveryState.agents.length === 0) {
			void getAgentsRpc({ projectSlug })
				.then(applyGetAgentsResponse)
				.catch((err) => log.warn("Visibility agents fetch failed:", err));
		}
	});

	// No busy-guard by design: every call sends the ABSOLUTE hidden lists
	// computed from current state, so rapid toggles are last-write-wins safe;
	// a guard would silently drop input and desync the toggles.
	async function persistHidden(update: {
		hiddenModels?: string[];
		hiddenAgents?: string[];
	}): Promise<void> {
		const projectSlug = getRpcProjectSlug();
		if (!projectSlug) return;
		const prevModels = discoveryState.hiddenModels;
		const prevAgents = discoveryState.hiddenAgents;
		// Optimistic update; the visibility_info broadcast confirms it.
		if (update.hiddenModels) discoveryState.hiddenModels = update.hiddenModels;
		if (update.hiddenAgents) discoveryState.hiddenAgents = update.hiddenAgents;
		try {
			await setHiddenEntriesRpc({ projectSlug, ...update });
		} catch {
			discoveryState.hiddenModels = prevModels;
			discoveryState.hiddenAgents = prevAgents;
			showToast("Failed to save visibility settings", { variant: "warn" });
		}
	}

	function toggleModel(providerId: string, modelId: string): void {
		const key = `${providerId}/${modelId}`;
		const next = new Set(discoveryState.hiddenModels);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		void persistHidden({ hiddenModels: [...next] });
	}

	function toggleProviderAll(providerId: string, hide: boolean): void {
		const provider = discoveryState.providers.find((p) => p.id === providerId);
		if (!provider) return;
		const next = new Set(discoveryState.hiddenModels);
		for (const m of provider.models) {
			const key = `${providerId}/${m.id}`;
			if (hide) next.add(key);
			else next.delete(key);
		}
		void persistHidden({ hiddenModels: [...next] });
	}

	function toggleAgent(agentId: string): void {
		if (!agentScopeId) return;
		const key = `${agentScopeId}/${agentId}`;
		const next = new Set(discoveryState.hiddenAgents);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		void persistHidden({ hiddenAgents: [...next] });
	}

</script>

<!-- ─── Copyable command block snippet ────────────────────────────────────── -->
{#snippet cmdBlock(cmd: string, key: string)}
	<div class="group/cmd flex items-start gap-1.5 bg-black/[0.04] dark:bg-white/[0.06] rounded px-2.5 py-1.5 font-mono text-xs text-text leading-relaxed">
		<span class="flex-1 whitespace-pre-wrap break-all select-all">{cmd}</span>
		<TextButton type="button" class="shrink-0 p-0.5 opacity-0 group-hover/cmd:opacity-100 transition-opacity" title="Copy" aria-label="Copy" onclick={() => handleCopy(cmd, key)}>
			{#if copiedKey === key}<Icon name="check" size={13} class="text-green-500" />{:else}<Icon name="copy" size={13} />{/if}
		</TextButton>
	</div>
{/snippet}

<Modal open={visible} onclose={() => onClose?.()} labelledBy="settings-panel-title" backdrop="subtle">
		<div id="settings-panel" class="bg-bg border border-border rounded-xl shadow-2xl max-w-lg w-[calc(100vw-2rem)] mx-4 flex flex-col max-h-[80vh]">
			<!-- Header -->
			<div class="shrink-0 flex items-center justify-between px-5 py-3 border-b border-border">
				<h2 id="settings-panel-title" class="text-lg font-semibold text-text font-brand">Settings</h2>
				<!-- `ghost` is a shade darker than this control and carries a hover
				     fill it has never had. Both are REPLACED rather than overridden:
				     the `!` triple this used to carry was important at every state,
				     so it also had to beat ghost's own `hover:text-text`. -->
				<Button
					iconOnly
					ariaLabel="Close settings"
					icon="x"
					variant="ghost"
					tone="muted"
					hoverFill="none"
					size="content"
					class="p-1"
					data-testid="settings-close-btn"
					onclick={() => onClose?.()}
				/>
			</div>

			<!-- Tabs.
			     shrink-0 is load-bearing: the strip scrolls horizontally, which makes
			     this flex item's automatic minimum height zero rather than content
			     height, so without it a tall tab squeezes the bar down to a sliver. -->
			<Tabs
				bind:value={activeTab}
				variant="underline"
				label="Settings sections"
				options={SETTINGS_TABS}
				class="shrink-0"
			/>

			<!-- Tab content -->
			<div class="flex-1 overflow-y-auto p-5">

				<!-- ═══ Notifications ═══ -->
				{#if activeTab === "notifications"}
					<div class="space-y-2">
						<Toggle
							icon="smartphone"
							label="Push notifications"
							description="Receive push notifications even when the tab is closed"
							checked={notifSettings.push}
							onchange={togglePush}
							disabled={pushBusy || pushUnavailable}
							class="bg-bg-surface border border-border rounded-panel px-5 py-4 gap-4 font-brand"
						/>
						<Toggle
							icon="bell"
							label="Browser alerts"
							description="Show desktop notifications when tasks complete"
							checked={notifSettings.browser}
							onchange={toggleBrowser}
							class="bg-bg-surface border border-border rounded-panel px-5 py-4 gap-4 font-brand"
						/>
						<Toggle
							icon="volume-2"
							label="Sound"
							description="Play a sound when notifications are triggered"
							checked={notifSettings.sound}
							onchange={toggleSound}
							class="bg-bg-surface border border-border rounded-panel px-5 py-4 gap-4 font-brand"
						/>
						{#if pushUnavailable}
							<div class="px-2 py-1.5 text-xs text-text-muted">Push notifications require HTTPS. Enable a certificate in the CLI settings.</div>
						{:else if pushError}
							<div class="px-2 py-1.5 text-xs text-error">{pushError}</div>
						{:else if pushBlocked}
							<div class="px-2 py-1.5 text-xs text-error">Push notifications are blocked by your browser. Update site settings to allow notifications.</div>
						{:else if browserBlocked}
							<div class="px-2 py-1.5 text-xs text-error">Browser alerts are blocked. Update site settings to allow notifications.</div>
						{/if}
					</div>

				<!-- ═══ Appearance ═══ -->
				{:else if activeTab === "appearance"}
					<Surface variant="card" padding="lg" radius="panel" class="font-brand">
						<label for="theme-mode" class="block text-base font-medium text-text">
							Theme
						</label>
						<p class="mt-1 text-xs text-text-muted">
							Choose a fixed appearance or follow your system setting.
						</p>
						<Select
							id="theme-mode"
							value={themeState.mode}
							class="mt-3 w-full"
							onchange={(event) =>
								setThemeMode(
									(event.currentTarget as HTMLSelectElement).value as ThemeMode,
								)}
						>
							<option value="light">Light</option>
							<option value="dark">Dark</option>
							<option value="system">System</option>
						</Select>
					</Surface>
					<Surface variant="card" padding="lg" radius="panel" class="mt-4 font-brand">
						<label for="settings-auto-settle-select" class="block text-base font-medium text-text">Settle idle sessions after</label>
						<Select
							id="settings-auto-settle-select"
							data-testid="settings-auto-settle-select"
							value={autoSettleDays === null ? "never" : String(autoSettleDays)}
							disabled={autoSettleSaving}
							class="mt-3 w-full"
							onchange={(event) => {
								const value = event.currentTarget.value;
								const next = value === "never" ? null : Number(value);
								autoSettleSaving = true;
								void setAutoSettleSettingRpc(next)
									.then((days) => {
										autoSettleDays = days;
									})
									.catch(() => {
										showToast("Couldn't save auto-settle setting", { variant: "error" });
									})
									.finally(() => {
										autoSettleSaving = false;
									});
							}}
						>
							<option value="1">1 day</option>
							<option value="2">2 days</option>
							<option value="3">3 days</option>
							<option value="7">1 week</option>
							<option value="14">2 weeks</option>
							<option value="30">30 days</option>
							<option value="90">90 days</option>
							<option value="never">Never</option>
						</Select>
						<p class="mt-1 text-xs text-text-muted">
							Settled sessions move to the Settled shelf. Nothing is deleted.
						</p>
					</Surface>

				<!-- ═══ Agents & Models ═══ -->
				{:else if activeTab === "visibility"}
					<div class="space-y-4">
						<div class="px-1 text-xs text-text-muted font-brand">
							Unchecked items are hidden from the input-area dropdowns. New
							models and agents appear automatically.
						</div>

						<!-- Models -->
						{#if modelProviders.length === 0}
							<div class="px-1 text-xs text-text-muted font-brand">
								{modelsFetchPending ? "Loading models…" : "No models available"}
							</div>
						{/if}
						{#each modelProviders as provider (provider.id)}
							{@const allHidden = provider.models.every((m) => hiddenModelSet.has(`${provider.id}/${m.id}`))}
							<div>
								<div class="flex items-center justify-between px-1 mb-2">
									<div class="text-xs font-semibold uppercase tracking-widest text-text-muted font-brand">{provider.name}</div>
									<TextButton
										class="text-xs font-brand"
										onclick={() => toggleProviderAll(provider.id, !allHidden)}
									>
										{allHidden ? "Show all" : "Hide all"}
									</TextButton>
								</div>
								<Surface variant="card" radius="panel" class="space-y-1 px-4 py-2">
									{#each provider.models as model (model.id)}
										<Toggle
											label={model.name || model.id}
											checked={!hiddenModelSet.has(`${provider.id}/${model.id}`)}
											onchange={() => toggleModel(provider.id, model.id)}
											class="py-1.5 gap-3 font-brand border-none bg-transparent"
										/>
									{/each}
								</Surface>
							</div>
						{/each}

						<!-- Agents (current provider scope only) -->
						{#if agentScopeId && discoveryState.agents.length > 0}
							<div>
								<div class="text-xs font-semibold uppercase tracking-widest text-text-muted px-1 mb-2 font-brand">
									{discoveryState.agentProviderScope?.name} agents
								</div>
								<Surface variant="card" radius="panel" class="space-y-1 px-4 py-2">
									{#each discoveryState.agents as agent (agent.id)}
										<Toggle
											label={agent.name || agent.id}
											checked={!hiddenAgentSet.has(`${agentScopeId}/${agent.id}`)}
											onchange={() => toggleAgent(agent.id)}
											class="py-1.5 gap-3 font-brand border-none bg-transparent"
										/>
									{/each}
								</Surface>
							</div>
						{/if}
					</div>

				<!-- ═══ Claude ═══ -->
				{:else if activeTab === "claude"}
					<ClaudeSettingsTab />

				<!-- ═══ Instances ═══ -->
				{:else if activeTab === "instances"}
					<div id="instances-settings">
					<div class="flex items-center justify-between mb-3">
						<span class="text-xs text-text-muted font-medium uppercase tracking-wide font-brand">
							{instances.length} instance{instances.length !== 1 ? "s" : ""}
						</span>
						<div class="flex items-center gap-2">
						<!-- Icon stays a child rather than `icon=`: Button renders it at
						     16, this is 12, and only a child can carry the spin class. -->
						<Button
							variant="secondary"
							tone="muted"
							hoverFill="none"
							size="content"
							class="gap-1.5 px-2.5 py-1 text-xs rounded hover:border-text-muted font-brand"
							data-testid="scan-now-btn"
							disabled={scanInFlight}
							onclick={handleScanNow}
						>
							<Icon name="refresh-cw" size={12} class={scanInFlight ? "animate-spin" : ""} />
							{scanInFlight ? "Scanning..." : "Scan Now"}
						</Button>
						<Button
							variant="ghost-accent"
							size="content"
							class="gap-1.5 px-2.5 py-1 text-xs rounded border border-accent font-brand"
							data-testid="add-instance-btn"
							onclick={() => openAddInstance()}
						>
							<Icon name="plus" size={12} />
							Add
						</Button>
						</div>
					</div>

					{#if instanceFormMode !== null}
						<div class="mb-3 border border-border rounded-lg p-3 space-y-3 font-brand" data-testid="instance-form">
							<div class="flex items-center justify-between">
								<span class="text-xs text-text-muted font-medium uppercase tracking-wide">
									{instanceFormMode === "edit" ? "Edit instance" : "New instance"}
								</span>
							</div>
							{#if instanceFormMode === "add"}
								<SegmentedControl
									bind:value={formDriver}
									label="Driver"
									options={DRIVER_TAB_OPTIONS}
								/>
							{/if}
							<label class="block space-y-1">
								<span class="text-xs text-text-muted">Name</span>
								<TextInput
									data-testid="instance-form-name"
									placeholder={formDriver === "claude" ? "Work Claude" : "Staging OC"}
									bind:value={formName}
								/>
							</label>
							{#if formDriver === "claude"}
								<label class="block space-y-1">
									<span class="text-xs text-text-muted">Config directory <span class="opacity-60">(optional)</span></span>
									<TextInput
										data-testid="instance-form-configdir"
										placeholder="~/.config/claude/work"
										bind:value={formConfigDir}
									/>
								</label>
							{:else}
								<label class="flex items-center gap-2 text-sm text-text cursor-pointer">
									<Checkbox data-testid="instance-form-managed" bind:checked={formManaged} />
									<span>Managed <span class="text-xs text-text-muted">(conduit starts the server)</span></span>
								</label>
								{#if formManaged}
									<label class="block space-y-1">
										<span class="text-xs text-text-muted">Port</span>
										<TextInput inputmode="numeric" data-testid="instance-form-port" placeholder="4098" bind:value={formPort} />
									</label>
								{:else}
									<label class="block space-y-1">
										<span class="text-xs text-text-muted">URL <span class="opacity-60">(or port)</span></span>
										<TextInput data-testid="instance-form-url" placeholder="http://127.0.0.1:4098" bind:value={formUrl} />
									</label>
									<label class="block space-y-1">
										<span class="text-xs text-text-muted">Port <span class="opacity-60">(optional)</span></span>
										<TextInput inputmode="numeric" data-testid="instance-form-port" placeholder="4098" bind:value={formPort} />
									</label>
								{/if}
								<label class="block space-y-1">
									<span class="text-xs text-text-muted">Environment <span class="opacity-60">(KEY=VALUE per line, optional)</span></span>
									<Textarea data-testid="instance-form-env" rows={2} class="resize-y font-mono" placeholder="ANTHROPIC_API_KEY=sk-ant-..." bind:value={formEnv} />
								</label>
							{/if}
							<div class="flex justify-end gap-2 pt-1">
								<Button variant="secondary" tone="muted" hoverFill="none" size="content" class="px-3 py-1 text-xs rounded" data-testid="instance-form-cancel" onclick={closeInstanceForm}>Cancel</Button>
								<Button variant="ghost-accent" size="content" class="px-3 py-1 text-xs rounded border border-accent" data-testid="instance-form-save" disabled={formSaving} onclick={submitInstanceForm}>{formSaving ? "Saving..." : "Save"}</Button>
							</div>
						</div>
					{/if}

					{#if scanResult && !scanInFlight}
					<div class="mb-3 text-xs text-text-muted bg-white/[0.04] rounded px-2.5 py-1.5 font-brand">
							{#if scanResult.discovered.length > 0}
								Found {scanResult.discovered.length} new instance{scanResult.discovered.length !== 1 ? "s" : ""} on port{scanResult.discovered.length !== 1 ? "s" : ""} {scanResult.discovered.join(", ")}.
							{:else if scanResult.lost.length > 0}
								{scanResult.lost.length} instance{scanResult.lost.length !== 1 ? "s" : ""} lost (port{scanResult.lost.length !== 1 ? "s" : ""} {scanResult.lost.join(", ")}).
							{:else if scanResult.active.length > 0}
								{scanResult.active.length} active instance{scanResult.active.length !== 1 ? "s" : ""} on port{scanResult.active.length !== 1 ? "s" : ""} {scanResult.active.join(", ")} (no changes).
							{:else}
								No active instances found.
							{/if}
						</div>
					{/if}

					{#if instances.length > 0}
					<div id="instance-settings-list" class="space-y-1 font-brand">
							{#each instances as inst}
								{@const driver = instanceDriver(inst)}
								<div class="border border-border rounded-lg" data-testid="instance-row-{inst.id}" data-driver={driver}>
									<Disclosure expanded={expandedInstanceId === inst.id} onToggle={() => handleToggleInstance(inst.id)} chevron={false} look="row" density="split" class="justify-between">
										<div class="flex items-center gap-2 min-w-0">
											<span class={"w-2 h-2 rounded-full shrink-0 " + instanceStatusColor(inst.status)}></span>
											{#if renamingInstanceId === inst.id}
												<!-- svelte-ignore a11y_autofocus -->
												<!-- The bespoke version hard-coded `border-accent` to say "this
												     one is live". TextInput already says that on focus, and the
												     row is autofocused, so the signal survives the migration --
												     which matters, because an additive `border-accent` here would
												     silently lose to the base `border-border` (Tailwind emits
												     border-colour utilities alphabetically). -->
												<TextInput aria-label="Instance name" size="sm" class="w-36" bind:value={renameValue} onkeydown={handleRenameKeydown} onclick={(e) => e.stopPropagation()} onfocusout={submitRename} autofocus />
											{:else}
												<span class="font-medium text-text truncate">{inst.name}</span>
											{/if}
											<Badge variant="tag" shape="pill">{driver === "claude" ? "Claude" : "OpenCode"}</Badge>
											{#if driver === "opencode" && !inst.managed}
												<Badge variant="tag" shape="pill">discovered</Badge>
											{/if}
										</div>
										{#if driver === "claude"}
											<span class="text-text-muted text-xs shrink-0 ml-2 truncate max-w-[10rem]">{inst.configDir || "env"}</span>
										{:else}
											<span class="text-text-muted text-xs shrink-0 ml-2">:{inst.port}</span>
										{/if}
									</Disclosure>
									{#if expandedInstanceId === inst.id}
										<div class="flex flex-wrap gap-2 px-3 py-2 border-t border-border">
										{#if driver === "opencode" && inst.managed}
											<Button variant="secondary" size="content" class="px-3 py-1 text-xs rounded" onclick={() => handleStart(inst.id)}>Start</Button>
											<Button variant="secondary" size="content" class="px-3 py-1 text-xs rounded" onclick={() => handleStop(inst.id)}>Stop</Button>
											{/if}
											<Button variant="ghost-accent" size="content" class="px-3 py-1 text-xs rounded border border-border" data-testid="edit-instance-btn" onclick={() => openEditInstance(inst)}>Edit</Button>
											<Button variant="ghost-accent" size="content" class="px-3 py-1 text-xs rounded border border-border" data-testid="rename-instance-btn" onclick={() => startRename(inst.id, inst.name)}>Rename</Button>
										<!-- Three `!` and every one of them is raw Tailwind palette, not a
										     token: border-red-700 / text-red-500 are the headline drift item
										     for the de3.5 NORMALIZE pass. -->
										<Button variant="danger-outline" size="content" class="px-3 py-1 text-xs rounded" data-testid="remove-instance-btn" onclick={() => handleRemove(inst.id, inst.name)}>Remove</Button>
										</div>
									{/if}
								</div>
							{/each}
						</div>
					{/if}

					{#if instances.length === 0}
					<div class="mt-2 space-y-2 font-brand">
							<p class="text-sm text-text-muted mb-3">No OpenCode instances detected. Start one from your terminal and it will appear here automatically.</p>
							<div class="border border-border rounded-lg overflow-hidden">
								<Disclosure expanded={expandedScenario === "direct"} onToggle={() => toggleScenario("direct")} chevron={false} look="section" density="roomy">
									<Icon name={expandedScenario === "direct" ? "chevron-down" : "chevron-right"} size={14} class="text-text-muted shrink-0" />
									<span>Quick Start — Direct API Key</span>
								</Disclosure>
								{#if expandedScenario === "direct"}
									<div class="px-3 pb-3 space-y-2 border-t border-border pt-2.5">
										<p class="text-xs text-text-muted">1. Start an OpenCode server:</p>
										{@render cmdBlock("opencode serve --port 4098", "direct-1")}
										<p class="text-xs text-text-muted">2. Configure your provider:</p>
										{@render cmdBlock("opencode config set provider anthropic\nopencode config set anthropic.apiKey sk-ant-...", "direct-2")}
										<p class="text-xs text-text-muted italic">It will appear here automatically.</p>
									</div>
								{/if}
							</div>
							<div class="border border-border rounded-lg overflow-hidden">
								<Disclosure expanded={expandedScenario === "ccs"} onToggle={() => toggleScenario("ccs")} chevron={false} look="section" density="roomy">
									<Icon name={expandedScenario === "ccs" ? "chevron-down" : "chevron-right"} size={14} class="text-text-muted shrink-0" />
									<span>Multi-Provider — Via CCS</span>
									{#if ccsDetected}<Icon name="circle-check" size={14} class="text-green-500 ml-auto shrink-0" />{:else if proxyResult === null}<span class="text-xs text-text-muted animate-pulse ml-auto">detecting...</span>{/if}
								</Disclosure>
								{#if expandedScenario === "ccs"}
									<div class="px-3 pb-3 space-y-2 border-t border-border pt-2.5">
										<p class="text-xs text-text-muted">CCS manages OAuth tokens and API keys for 20+ providers.</p>
										{#if ccsDetected}
											<div class="flex items-center gap-1.5 text-xs text-green-400 bg-green-500/10 rounded px-2 py-1"><Icon name="circle-check" size={12} />CCS detected on port {proxyResult?.port ?? 8317}</div>
										{/if}
										<p class="text-xs text-text-muted">1. Install CCS:</p>
										{@render cmdBlock("npm install -g @anthropic-ai/ccs", "ccs-1")}
										<p class="text-xs text-text-muted">2. Authenticate:</p>
										{@render cmdBlock("ccs claude --auth", "ccs-2")}
										<p class="text-xs text-text-muted">3. Start proxy:</p>
										{@render cmdBlock("ccs cliproxy start", "ccs-3")}
										<p class="text-xs text-text-muted">4. Start OpenCode:</p>
										{@render cmdBlock('ANTHROPIC_API_KEY="ccs-internal-managed" \\\n  ANTHROPIC_BASE_URL="http://127.0.0.1:8317/api/provider/claude/v1" \\\n  opencode serve --port 4098', "ccs-4")}
									</div>
								{/if}
							</div>
							<div class="border border-border rounded-lg overflow-hidden">
								<Disclosure expanded={expandedScenario === "custom"} onToggle={() => toggleScenario("custom")} chevron={false} look="section" density="roomy">
									<Icon name={expandedScenario === "custom" ? "chevron-down" : "chevron-right"} size={14} class="text-text-muted shrink-0" />
									<span>Custom Setup</span>
								</Disclosure>
								{#if expandedScenario === "custom"}
									<div class="px-3 pb-3 space-y-2 border-t border-border pt-2.5">
										<p class="text-xs text-text-muted">Configure with environment variables:</p>
										{@render cmdBlock("ANTHROPIC_API_KEY=sk-ant-... opencode serve --port 4098", "custom-1")}
									</div>
								{/if}
							</div>
							<div class="flex items-center justify-center gap-2 pt-2 text-xs text-text-muted">
								<span>Already started?</span>
								<TextButton type="button" tone="accent" class="font-medium" data-testid="scan-now-link" onclick={handleScanNow}>{scanInFlight ? "Scanning..." : "Scan Now"}</TextButton>
							</div>
						</div>
					{/if}
					</div>

				<!-- ═══ Debug ═══ -->
				{:else if activeTab === "debug"}
					<div class="space-y-2">
						<Toggle
							label="Connection debug panel"
							description="Shows WebSocket state transitions, timing, and lifecycle events."
							checked={featureFlags.debug}
							onchange={() => toggleFeature("debug")}
							class="bg-bg-surface border border-border rounded-panel px-5 py-4 gap-4 font-brand"
						/>
						<div class="text-xs text-text-dimmer space-y-1.5 px-1 font-brand">
							<div>URL param: <code class="px-1 py-0.5 bg-white/[0.08] rounded text-text-muted">?feats=debug</code></div>
							<div>Keyboard: <kbd class="px-1.5 py-0.5 bg-white/[0.08] rounded text-text-muted border border-border/50">Ctrl+Shift+D</kbd></div>
						</div>
					</div>
				{/if}
			</div>
		</div>
</Modal>
