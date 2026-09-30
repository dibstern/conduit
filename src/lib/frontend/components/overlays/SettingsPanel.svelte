<!-- ─── Settings Panel ────────────────────────────────────────────────────── -->
<!-- Modal settings panel with tabbed navigation. Uses the 68-mockup card   -->
<!-- design. Tabs: Notifications, Appearance, Agents & Models, Claude,      -->
<!-- Instances, Debug.                                                      -->

<script lang="ts">
	import { untrack } from "svelte";
	import Dialog from "../ui/Dialog.svelte";
	import Button from "../ui/Button.svelte";
	import Tabs from "../ui/Tabs.svelte";
	import ClaudeSettingsTab from "./ClaudeSettingsTab.svelte";
	import NotificationsSettingsTab from "./NotificationsSettingsTab.svelte";
	import AppearanceSettingsTab from "./AppearanceSettingsTab.svelte";
	import VisibilitySettingsTab from "./VisibilitySettingsTab.svelte";
	import InstancesSettingsTab from "./InstancesSettingsTab.svelte";
	import DebugSettingsTab from "./DebugSettingsTab.svelte";
	import { applyDetectProxyResponse, beginProxyDetection } from "../../stores/instance.svelte.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import { getNotifSettings } from "../../utils/notif-settings.js";
	import { clearClaudeSettingEdits } from "../../stores/claude-settings.svelte.js";
	import { getCurrentSlug } from "../../stores/router.svelte.js";
	import { detectProxyRpc, getAutoSettleSettingRpc } from "../../transport/ws-rpc-client.js";

	let { visible = false, initialTab = "notifications", onClose }:
		{ visible: boolean; initialTab?: string; onClose?: () => void } = $props();
	let activeTab = $state("notifications");
	let appearanceState = $state({ autoSettleDays: 3 as number | null, autoSettleSaving: false });
	let notificationState = $state({
		notifSettings: getNotifSettings(),
		pushBlocked: typeof Notification !== "undefined" && Notification.permission === "denied",
		browserBlocked: typeof Notification !== "undefined" && Notification.permission === "denied",
		pushBusy: false,
		pushError: "",
	});
	let visibilityState = $state({ modelsFetchPending: false });
	let instanceState = $state({
		expandedInstanceId: null as string | null,
		renamingInstanceId: null as string | null,
		renameValue: "",
		expandedScenario: null as string | null,
		copiedKey: null as string | null,
		copyTimer: null as ReturnType<typeof setTimeout> | null,
		instanceFormMode: null as "add" | "edit" | null,
		editingInstanceId: null as string | null,
		formDriver: "opencode" as "claude" | "opencode",
		formName: "",
		formConfigDir: "",
		formManaged: false,
		formPort: "",
		formUrl: "",
		formEnv: "",
		formSaving: false,
	});
	const SETTINGS_TABS = [
		{ value: "notifications", label: "Alerts", testId: "settings-tab-notifications" },
		{ value: "appearance", label: "Theme", testId: "settings-tab-appearance" },
		{ value: "visibility", label: "Agents & Models", testId: "settings-tab-visibility" },
		{ value: "claude", label: "Claude", testId: "settings-tab-claude" },
		{ value: "instances", label: "Instances", testId: "settings-tab-instances" },
		{ value: "debug", label: "Debug", testId: "settings-tab-debug" },
	];

	$effect(() => {
		if (visible) {
			void getAutoSettleSettingRpc()
				.then((days) => { appearanceState.autoSettleDays = days; })
				.catch(() => { showToast("Couldn't load auto-settle setting", { variant: "error" }); });
			clearClaudeSettingEdits();
			activeTab = initialTab;
			Object.assign(instanceState, {
				expandedInstanceId: null,
				renamingInstanceId: null,
				expandedScenario: null,
				instanceFormMode: null,
				editingInstanceId: null,
				formDriver: "opencode",
				formName: "",
				formConfigDir: "",
				formManaged: false,
				formPort: "",
				formUrl: "",
				formEnv: "",
				formSaving: false,
			});
			if (!untrack(() => notificationState.pushBusy)) {
				notificationState.notifSettings = getNotifSettings();
			}
			const projectSlug = getCurrentSlug();
			if (projectSlug) {
				beginProxyDetection();
				void detectProxyRpc({ projectSlug })
					.then(applyDetectProxyResponse)
					.catch(() => applyDetectProxyResponse({ projectSlug, found: false, port: 8317 }));
			}
		} else {
			clearClaudeSettingEdits();
		}
	});
</script>

<Dialog open={visible} onclose={() => onClose?.()} labelledBy="settings-panel-title" backdrop="subtle">
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
					<NotificationsSettingsTab bind:state={notificationState} />
				<!-- ═══ Appearance ═══ -->
				{:else if activeTab === "appearance"}
					<AppearanceSettingsTab bind:state={appearanceState} />
				<!-- ═══ Agents & Models ═══ -->
				{:else if activeTab === "visibility"}
					<VisibilitySettingsTab {visible} bind:state={visibilityState} />
				<!-- ═══ Claude ═══ -->
				{:else if activeTab === "claude"}
					<ClaudeSettingsTab />
				<!-- ═══ Instances ═══ -->
				{:else if activeTab === "instances"}
					<InstancesSettingsTab bind:state={instanceState} />
				<!-- ═══ Debug ═══ -->
				{:else if activeTab === "debug"}
					<DebugSettingsTab />
				{/if}
			</div>
		</div>
</Dialog>

<style>
	/* 80vh is fractional on most phones. A whole-pixel cap keeps the panel's
	   bottom border crisp; the max-h-[80vh] class is the fallback. */
	#settings-panel {
		max-height: round(down, 80vh, 1px);
	}
</style>
