<!-- Modal settings panel in frame H's layout (2026-10-07 account-switch design): -->
<!-- a vertical section list beside the open section on desktop; on phone the   -->
<!-- list is the first screen and a section drills in one level.               -->

<script lang="ts">
	import { tick, untrack } from "svelte";
	import { MediaQuery } from "svelte/reactivity";
	import Dialog from "../ui/Dialog.svelte";
	import Button from "../ui/Button.svelte";
	import Icon from "../ui/Icon.svelte";
	import Tabs from "../ui/Tabs.svelte";
	import ClaudeSettingsTab from "./ClaudeSettingsTab.svelte";
	import NotificationsSettingsTab from "./NotificationsSettingsTab.svelte";
	import AppearanceSettingsTab from "./AppearanceSettingsTab.svelte";
	import ComposerSettingsTab from "./ComposerSettingsTab.svelte";
	import VisibilitySettingsTab from "./VisibilitySettingsTab.svelte";
	import InstancesSettingsTab from "./InstancesSettingsTab.svelte";
	import DebugSettingsTab from "./DebugSettingsTab.svelte";
	import { applyDetectProxyResponse, beginProxyDetection } from "../../stores/instance.svelte.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import { getNotifSettings } from "../../utils/notif-settings.js";
	import { clearClaudeSettingEdits } from "../../stores/claude-settings.svelte.js";
	import { getCurrentRoute, getCurrentSlug } from "../../stores/router.svelte.js";
	import { getIsConnected } from "../../transport/connection-status.svelte.js";
	import { detectProxyRpc, getAutoSettleSettingRpc } from "../../transport/ws-rpc-client.js";

	let { visible = false, initialTab, onClose }:
		{ visible: boolean; initialTab?: string | undefined; onClose?: () => void } = $props();
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
		{ value: "composer", label: "Composer", testId: "settings-tab-composer" },
		{ value: "visibility", label: "Agents & Models", testId: "settings-tab-visibility" },
		{ value: "claude", label: "Claude", testId: "settings-tab-claude" },
		{ value: "instances", label: "Instances", testId: "settings-tab-instances" },
		{ value: "debug", label: "Debug", testId: "settings-tab-debug" },
	];
	const phone = new MediaQuery("(max-width: 767px)");
	/** `null` only on phone, where it means the section list is the screen. */
	let section = $state<string | null>("notifications");
	let backEl = $state<HTMLButtonElement | HTMLAnchorElement>();
	const shown = $derived(section ?? "notifications");
	const listHidden = $derived(phone.current && section !== null);
	const sectionLabel = $derived(SETTINGS_TABS.find((tab) => tab.value === section)?.label ?? "Settings");

	$effect(() => {
		if (visible) {
			clearClaudeSettingEdits();
			section = initialTab ?? (untrack(() => phone.current) ? null : "notifications");
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

	async function openSection(next: string): Promise<void> {
		section = next;
		if (!phone.current) return;
		await tick();
		backEl?.focus();
	}

	async function showSectionList(): Promise<void> {
		const from = section;
		section = null;
		await tick();
		document.querySelector<HTMLElement>(`[data-testid="settings-tab-${from}"]`)?.focus();
	}

	$effect(() => {
		if (!visible || !getIsConnected()) return;
		const route = getCurrentRoute();
		if (route.page === "chat" && route.sessionId && !getCurrentSlug()) return;
		let current = true;
		void getAutoSettleSettingRpc()
			.then((days) => {
				if (current && !appearanceState.autoSettleSaving) appearanceState.autoSettleDays = days;
			})
			.catch(() => {
				if (current) showToast("Couldn't load auto-settle setting", { variant: "error" });
			});
		return () => { current = false; };
	});
</script>

<Dialog open={visible} onclose={() => onClose?.()} labelledBy="settings-panel-title" backdrop="subtle">
	<div
		id="settings-panel"
		class="bg-bg border border-border rounded-xl shadow-2xl w-[calc(100vw-2rem)] md:w-[min(720px,calc(100vw-2rem))] h-[80vh] md:h-[min(600px,80vh)] flex flex-col overflow-hidden font-brand"
	>
		<div class="shrink-0 flex items-center gap-[6px] px-[14px] py-[10px] border-b border-border-subtle">
			{#if listHidden}
				<Button
					bind:element={backEl}
					variant="ghost"
					size="content"
					iconOnly
					icon="chevron-left"
					iconSize={16}
					touchTarget
					ariaLabel="Back to settings sections"
					data-testid="settings-back-btn"
					class="h-7 w-7 rounded-lg"
					onclick={showSectionList}
				/>
			{/if}
			<h2 id="settings-panel-title" class="flex-1 min-w-0 truncate text-[14px] font-semibold text-text">
				{listHidden ? sectionLabel : "Settings"}
			</h2>
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

		<div class="flex flex-1 min-h-0">
			<!-- Frame H: a left section list on desktop. On phone it is the whole
			     first screen; picking a section drills in, and the header's back
			     control returns. Manual activation there, so arrowing through the
			     list does not drill in on every keypress. -->
			{#if !listHidden}
				<div class="shrink-0 overflow-y-auto px-[8px] py-[12px] {phone.current ? 'flex-1' : 'w-[150px] border-r border-border-subtle'}">
					<Tabs
						value={phone.current ? "" : shown}
						variant="sections"
						orientation="vertical"
						activationMode={phone.current ? "manual" : "automatic"}
						label="Settings sections"
						options={SETTINGS_TABS}
						onValueChange={openSection}
					>
						{#snippet optionContent(option)}
							<span class="flex-1">{option.label}</span>
							{#if phone.current}
								<Icon name="chevron-right" size={14} class="text-text-dimmer" />
							{/if}
						{/snippet}
					</Tabs>
				</div>
			{/if}

			{#if !phone.current || section !== null}
				<div class="flex-1 min-w-0 overflow-y-auto px-[18px] py-[14px] flex flex-col gap-[7px] text-[11.5px] text-text-secondary">
					{#if shown === "notifications"}
						<NotificationsSettingsTab bind:state={notificationState} />
					{:else if shown === "appearance"}
						<AppearanceSettingsTab bind:state={appearanceState} />
					{:else if shown === "composer"}
						<ComposerSettingsTab />
					{:else if shown === "visibility"}
						<VisibilitySettingsTab {visible} bind:state={visibilityState} />
					{:else if shown === "claude"}
						<ClaudeSettingsTab />
					{:else if shown === "instances"}
						<InstancesSettingsTab bind:state={instanceState} />
					{:else if shown === "debug"}
						<DebugSettingsTab />
					{/if}
				</div>
			{/if}
		</div>
	</div>
</Dialog>

<style>
	/* 80vh is fractional on most phones. Whole-pixel sizes keep the panel's
	   borders crisp; the h-[80vh] classes are the fallback. The height is
	   fixed rather than content-sized so switching sections never re-centres
	   the dialog under the pointer. */
	#settings-panel {
		height: round(down, 80vh, 1px);
	}
	@media (min-width: 768px) {
		#settings-panel {
			height: min(600px, round(down, 80vh, 1px));
		}
	}
</style>
