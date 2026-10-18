<!-- Desktop dialog with a section rail; phone sections push full-screen pages. -->

<script lang="ts">
	import { tick, untrack } from "svelte";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import Dialog from "../ui/Dialog.svelte";
	import Button from "../ui/Button.svelte";
	import Icon from "../ui/Icon.svelte";
	import Tabs from "../ui/Tabs.svelte";
	import ClaudeSettingsTab from "./ClaudeSettingsTab.svelte";
	import ArchivedSettingsTab from "./ArchivedSettingsTab.svelte";
	import UsageSettingsTab from "./UsageSettingsTab.svelte";
	import NotificationsSettingsTab from "./NotificationsSettingsTab.svelte";
	import AppearanceSettingsTab from "./AppearanceSettingsTab.svelte";
	import AvatarSettings from "./AvatarSettings.svelte";
	import ComposerSettingsTab from "./ComposerSettingsTab.svelte";
	import SessionsSettingsTab from "./SessionsSettingsTab.svelte";
	import VisibilitySettingsTab from "./VisibilitySettingsTab.svelte";
	import ServerSettingsTab from "./ServerSettingsTab.svelte";
	import DebugSettingsTab from "./DebugSettingsTab.svelte";
	import SurfacingSettingsTab from "./SurfacingSettingsTab.svelte";
	import type { SettingsSection } from "../layout/chrome-actions.js";
	import { getCachedInstances, instanceStatusColor } from "../../stores/instance.svelte.js";
	import { orderedSettingsUsageAccounts, usageAlert, usageState } from "../../stores/usage.svelte.js";

	let { visible = false, initialTab, initialAnchor, onClose }:
		{ visible: boolean; initialTab?: SettingsSection | undefined; initialAnchor?: "instances" | undefined; onClose?: () => void } = $props();
	const SETTINGS_TABS = [
		{ value: "general", label: "General", testId: "settings-tab-general", icon: "settings", iconTone: "neutral" },
		{ value: "models", label: "Models & agents", testId: "settings-tab-models", icon: "sliders-horizontal", iconTone: "purple" },
		{ value: "claude", label: "Claude", testId: "settings-tab-claude", icon: "claude", iconTone: "clay" },
		{ value: "surfacing", label: "Surfacing", testId: "settings-tab-surfacing", icon: "sparkle", iconTone: "purple" },
		{ value: "archived", label: "Archived", testId: "settings-tab-archived", icon: "archive", iconTone: "neutral" },
		{ value: "usage", label: "Usage", testId: "settings-tab-usage", groupLabel: "This computer", icon: "gauge", iconTone: "amber" },
		{ value: "server", label: "Server", testId: "settings-tab-server", icon: "server", iconTone: "green" },
	] as const;
	/** `null` only on phone, where it means the section list is the screen. */
	let section = $state<SettingsSection | null>("general");
	let backEl = $state<HTMLButtonElement | HTMLAnchorElement>();
	let contentEl = $state<HTMLDivElement>();
	let surfacingPage = $state<{ title: string; back: () => void } | null>(null);
	const shown = $derived(section ?? "general");
	const listHidden = $derived(sessionViewState.compact && section !== null);
	const sectionLabel = $derived(SETTINGS_TABS.find((tab) => tab.value === shown)?.label ?? "Settings");
	const alert = $derived(usageAlert(orderedSettingsUsageAccounts(), usageState.limits.warnAt));
	const unhealthyInstance = $derived(getCachedInstances().find((instance) => instance.status === "unhealthy"));

	$effect(() => {
		if (!visible) return;
		section = initialTab ?? (untrack(() => sessionViewState.compact) ? null : "general");
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
		surfacingPage = null;
		section = next;
		await scrollContent();
		if (!sessionViewState.compact) return;
		backEl?.focus();
	}

	async function showSectionList(): Promise<void> {
		const from = section;
		section = null;
		await tick();
		document.querySelector<HTMLElement>(`[data-testid="settings-tab-${from}"]`)?.focus();
	}

</script>

<Dialog open={visible} onclose={() => onClose?.()} labelledBy="settings-panel-title" backdrop="subtle" placement={sessionViewState.compact ? "fullscreen" : "center"}>
	<div
		id="settings-panel"
		class:phone={sessionViewState.compact}
		class="settings-panel bg-settings-bg ring-1 ring-border rounded-[16px] shadow-settings-dialog flex flex-col overflow-hidden font-sans leading-[1.35]"
	>
		<div class="settings-header shrink-0 bg-settings-rail {sessionViewState.compact ? 'grid grid-cols-[90px_minmax(0,1fr)_90px] items-center px-[8px]' : 'flex h-[52px] items-center px-[12px] pl-[20px] border-b border-settings-separator'}">
			{#if listHidden}
				<Button
					bind:element={backEl}
					variant="ghost"
					tone="accent"
					hoverFill="none"
					size="content"
					icon="chevron-left"
					iconSize={16}
					ariaLabel={surfacingPage ? "Back to Surfacing" : "Back to settings sections"}
					data-testid="settings-back-btn"
					class="min-h-[44px] justify-self-start text-[15px]"
					onclick={() => { if (surfacingPage) surfacingPage.back(); else void showSectionList(); }}
				>{surfacingPage ? "Surfacing" : "Settings"}</Button>
			{:else if sessionViewState.compact}
				<span></span>
			{/if}
			<h2 id="settings-panel-title" class="min-w-0 truncate font-semibold text-text {sessionViewState.compact ? 'text-center text-[16px]' : 'flex-1 text-[15px]'}">
				{listHidden ? surfacingPage?.title ?? sectionLabel : "Settings"}
			</h2>
			{#if sessionViewState.compact && !listHidden}
				<Button variant="ghost" tone="accent" hoverFill="none" size="content" class="min-h-[44px] min-w-[44px] justify-self-end text-[15px]" data-testid="settings-close-btn" ariaLabel="Close settings" onclick={() => onClose?.()}>Done</Button>
			{:else}
				<Button iconOnly ariaLabel="Close settings" icon="x" iconSize={16} variant="ghost" tone="muted" hoverFill="none" size="content" class={sessionViewState.compact ? 'min-h-[44px] min-w-[44px] justify-self-end' : 'size-[28px]'} data-testid="settings-close-btn" onclick={() => onClose?.()} />
			{/if}
		</div>

		<div class="flex flex-1 min-h-0">
			<!-- Manual activation on phone keeps arrow keys from pushing a page. -->
			{#if !listHidden}
				<div class="shrink-0 overflow-y-auto {sessionViewState.compact ? 'flex-1 px-[14px] pt-[4px] pb-[20px]' : 'w-[172px] px-[8px] py-[10px] border-r border-settings-separator bg-settings-rail'}">
					{#if sessionViewState.compact}<AvatarSettings root />{/if}
					<Tabs
						value={sessionViewState.compact ? "" : shown}
						variant="sections"
						orientation="vertical"
						activationMode={sessionViewState.compact ? "manual" : "automatic"}
						label="Settings sections"
						options={SETTINGS_TABS}
						onValueChange={openSection}
					>
						{#snippet optionContent(option)}
							<span class="flex-1">{option.label}</span>
							{#if option.value === "usage" && alert}
								<span data-testid="settings-usage-dot" class="inline-block size-[7px] shrink-0 rounded-full {alert.level === 'limited' ? 'bg-fill-red' : 'bg-fill-amber'}"></span>
							{:else if option.value === "server" && unhealthyInstance}
								<span data-testid="settings-server-dot" class="inline-block size-[7px] shrink-0 rounded-full {instanceStatusColor(unhealthyInstance.status)}"></span>
							{/if}
							{#if sessionViewState.compact}
								<Icon name="chevron-right" size={14} class="text-text-dimmer" />
							{/if}
						{/snippet}
					</Tabs>
				</div>
			{/if}

			{#if !sessionViewState.compact || section !== null}
				<div class="settings-main relative flex flex-1 min-w-0 min-h-0">
				<div bind:this={contentEl} class="settings-content flex-1 min-w-0 overflow-y-auto text-[12px] text-text-secondary">
					{#if !sessionViewState.compact}
						<div class="mb-[16px] flex flex-wrap items-baseline gap-x-[10px]">
							<h2 class="text-[17px] font-semibold tracking-[-0.01em] text-text">{sectionLabel}</h2>
							{#if shown === "usage"}<p class="text-[12.5px] text-text-muted">This computer's accounts</p>{/if}
							{#if shown === "surfacing"}<p class="text-[12.5px] text-text-muted">Which mid-turn messages surface, and how</p>{/if}
						</div>
					{/if}
					<div class="flex flex-col">
					{#if shown === "general"}
						<AvatarSettings />
						<AppearanceSettingsTab />
						<ComposerSettingsTab />
						<NotificationsSettingsTab />
						<SessionsSettingsTab />
						<DebugSettingsTab />
					{:else if shown === "models"}
						<VisibilitySettingsTab />
					{:else if shown === "claude"}
						<ClaudeSettingsTab />
					{:else if shown === "surfacing"}
						<SurfacingSettingsTab onPageChange={(page) => { surfacingPage = page; void scrollContent(); }} />
					{:else if shown === "archived"}
						<ArchivedSettingsTab {onClose} />
					{:else if shown === "usage"}
						<UsageSettingsTab />
					{:else if shown === "server"}
						<ServerSettingsTab {onClose} onOpenUsage={() => openSection("usage")} />
					{/if}
					</div>
				</div>
				</div>
			{/if}
		</div>
	</div>
</Dialog>

<style>
	.settings-panel {
		width: min(720px, calc(100vw - 32px));
		height: min(600px, round(down, 80dvh, 1px));
	}
	.settings-content {
		padding: 18px 24px 64px;
	}
	.settings-main::after {
		content: "";
		position: absolute;
		inset: auto 0 0;
		height: 64px;
		background: linear-gradient(transparent, var(--color-settings-bg));
		pointer-events: none;
	}
	.phone {
		width: 100%;
		height: 100dvh;
		border: 0;
		border-radius: 0;
		box-shadow: none;
		padding-top: env(safe-area-inset-top, 0px);
		padding-bottom: env(safe-area-inset-bottom, 0px);
	}
	.phone .settings-header {
		height: 44px;
		background: var(--color-settings-bg);
	}
	.phone .settings-content {
		padding: 4px 14px 26px;
	}
	.phone .settings-main::after {
		display: none;
	}
</style>
