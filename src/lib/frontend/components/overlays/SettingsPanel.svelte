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
	import ArchivedSettingsTab from "./ArchivedSettingsTab.svelte";
	import UsageSettingsTab from "./UsageSettingsTab.svelte";
	import NotificationsSettingsTab from "./NotificationsSettingsTab.svelte";
	import AppearanceSettingsTab from "./AppearanceSettingsTab.svelte";
	import ComposerSettingsTab from "./ComposerSettingsTab.svelte";
	import SessionsSettingsTab from "./SessionsSettingsTab.svelte";
	import VisibilitySettingsTab from "./VisibilitySettingsTab.svelte";
	import ServerSettingsTab from "./ServerSettingsTab.svelte";
	import DebugSettingsTab from "./DebugSettingsTab.svelte";
	import type { SettingsSection } from "../layout/chrome-actions.js";
	import { getCachedInstances, instanceStatusColor } from "../../stores/instance.svelte.js";
	import { orderedSettingsUsageAccounts, usageAlert, usageState } from "../../stores/usage.svelte.js";

	let { visible = false, initialTab, initialAnchor, onClose }:
		{ visible: boolean; initialTab?: SettingsSection | undefined; initialAnchor?: "instances" | undefined; onClose?: () => void } = $props();
	const SETTINGS_TABS = [
		{ value: "general", label: "General", testId: "settings-tab-general" },
		{ value: "models", label: "Models & agents", testId: "settings-tab-models" },
		{ value: "claude", label: "Claude", testId: "settings-tab-claude" },
		{ value: "archived", label: "Archived", testId: "settings-tab-archived" },
		{ value: "usage", label: "Usage", testId: "settings-tab-usage", groupLabel: "This computer" },
		{ value: "server", label: "Server", testId: "settings-tab-server" },
	] as const;
	const phone = new MediaQuery("(max-width: 767px)");
	/** `null` only on phone, where it means the section list is the screen. */
	let section = $state<SettingsSection | null>("general");
	let backEl = $state<HTMLButtonElement | HTMLAnchorElement>();
	let contentEl = $state<HTMLDivElement>();
	const shown = $derived(section ?? "general");
	const listHidden = $derived(phone.current && section !== null);
	const sectionLabel = $derived(SETTINGS_TABS.find((tab) => tab.value === section)?.label ?? "Settings");
	const alert = $derived(usageAlert(orderedSettingsUsageAccounts(), usageState.limits.warnAt));
	const unhealthyInstance = $derived(getCachedInstances().find((instance) => instance.status === "unhealthy"));

	$effect(() => {
		if (!visible) return;
		section = initialTab ?? (untrack(() => phone.current) ? null : "general");
		void scrollContent(initialAnchor);
	});

	async function scrollContent(anchor?: "instances"): Promise<void> {
		await tick();
		if (!contentEl) return;
		contentEl.scrollTop = 0;
		if (anchor) contentEl.querySelector<HTMLElement>(`#${anchor}-settings`)?.scrollIntoView({ block: "start" });
	}

	async function openSection(next: SettingsSection | ""): Promise<void> {
		if (!next) return;
		section = next;
		await scrollContent();
		if (!phone.current) return;
		backEl?.focus();
	}

	async function showSectionList(): Promise<void> {
		const from = section;
		section = null;
		await tick();
		document.querySelector<HTMLElement>(`[data-testid="settings-tab-${from}"]`)?.focus();
	}

</script>

<Dialog open={visible} onclose={() => onClose?.()} labelledBy="settings-panel-title" backdrop="subtle" placement={phone.current && section === "usage" ? "sheet" : "center"}>
	<div
		id="settings-panel"
		class:usage-phone={phone.current && shown === "usage" && section !== null}
		class="bg-bg border border-border rounded-xl shadow-2xl w-[calc(100vw-2rem)] md:w-[min(720px,calc(100vw-2rem))] h-[80vh] md:h-[min(600px,80vh)] flex flex-col overflow-hidden font-brand leading-[1.35]"
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
							{#if option.value === "usage" && alert}
								<span data-testid="settings-usage-dot" class="mr-[6px] inline-block h-[6px] w-[6px] shrink-0 rounded-full {alert.level === 'limited' ? 'bg-fill-red' : 'bg-fill-amber'}"></span>
							{:else if option.value === "server" && unhealthyInstance}
								<span data-testid="settings-server-dot" class="mr-[6px] inline-block h-[6px] w-[6px] shrink-0 rounded-full {instanceStatusColor(unhealthyInstance.status)}"></span>
							{/if}
							<span class="flex-1">{option.label}</span>
							{#if phone.current}
								<Icon name="chevron-right" size={14} class="text-text-dimmer" />
							{/if}
						{/snippet}
					</Tabs>
				</div>
			{/if}

			{#if !phone.current || section !== null}
				<div bind:this={contentEl} class="settings-content flex-1 min-w-0 overflow-y-auto px-[18px] py-[14px] flex flex-col gap-[7px] text-[11.5px] text-text-secondary">
					{#if shown === "general"}
						<NotificationsSettingsTab />
						<AppearanceSettingsTab />
						<ComposerSettingsTab />
						<SessionsSettingsTab />
						<DebugSettingsTab />
					{:else if shown === "models"}
						<VisibilitySettingsTab />
					{:else if shown === "claude"}
						<ClaudeSettingsTab />
					{:else if shown === "archived"}
						<ArchivedSettingsTab {onClose} />
					{:else if shown === "usage"}
						<UsageSettingsTab />
					{:else if shown === "server"}
						<ServerSettingsTab {onClose} onOpenUsage={() => openSection("usage")} />
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
	@media (max-width: 767px) {
		#settings-panel.usage-phone {
			width: 100vw;
			height: 100dvh;
			border: 0;
			border-radius: 0;
			padding-top: env(safe-area-inset-top, 0px);
		}
		.usage-phone .settings-content {
			padding: 12px 14px calc(26px + env(safe-area-inset-bottom, 0px));
		}
	}
</style>
