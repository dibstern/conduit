<!-- Session approvals: controls and sheet rows open the ranked mode menu. -->

<script lang="ts">
	import Badge from "../ui/Badge.svelte";
	import Button from "../ui/Button.svelte";
	import Icon from "../ui/Icon.svelte";
	import Menu from "../ui/Menu.svelte";
	import MenuRadioGroup from "../ui/MenuRadioGroup.svelte";
	import MenuRadioItem from "../ui/MenuRadioItem.svelte";
	import {
		approvals,
		getRankedApprovalOptions,
	} from "../../stores/composer-settings.svelte.js";
	import { discoveryState } from "../../stores/discovery.svelte.js";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import { getProviderPresentation } from "../../utils/provider-presentation.js";
	import type { SessionPermissionMode } from "../../types.js";

	let { variant = "icons" }: { variant?: "icons" | "words" | "row" | undefined } = $props();

	const presentation: Record<
		SessionPermissionMode,
		{ microLabel: string; tone: string; glyphClass: string; description: string }
	> = {
		dontAsk: {
			microLabel: "NEVER",
			tone: "var(--color-p-never)",
			glyphClass: "text-p-never",
			description: "Denies anything not pre-approved.",
		},
		plan: {
			microLabel: "PLAN",
			tone: "var(--color-p-plan)",
			glyphClass: "text-p-plan",
			description: "Reads and proposes. No edits.",
		},
		ask: {
			microLabel: "ASK",
			tone: "var(--color-p-ask)",
			glyphClass: "text-p-ask",
			description: "Asks before each edit or command.",
		},
		acceptEdits: {
			microLabel: "EDITS",
			tone: "var(--color-p-edits)",
			glyphClass: "text-p-edits",
			description: "File edits run without asking.",
		},
		auto: {
			microLabel: "AUTO",
			tone: "var(--color-p-auto)",
			glyphClass: "text-p-auto",
			description: "A model approves or denies each action.",
		},
		full: {
			microLabel: "FULL",
			tone: "var(--color-p-full)",
			glyphClass: "text-p-full",
			description: "Everything runs. No prompts.",
		},
	};

	const phone = $derived(sessionViewState.composerTier === "phone");
	let open = $state(false);
	let autoNormalizationProvider: string | null = null;

	const currentMode = $derived(approvals.current?.mode ?? "ask");
	const currentLabel = $derived(approvals.current?.label ?? "Ask");
	const currentPresentation = $derived(presentation[currentMode]);
	const availableModes = $derived(getRankedApprovalOptions());
	const hot = $derived(currentMode !== (phone ? "ask" : discoveryState.defaultPermissionMode));

	$effect(() => {
		const providerId = discoveryState.currentProviderId;
		if (discoveryState.currentTraits?.permissionModes.includes("auto")) {
			autoNormalizationProvider = null;
			return;
		}
		if (
			providerId &&
			discoveryState.permissionMode === "auto" &&
			autoNormalizationProvider !== providerId
		) {
			autoNormalizationProvider = providerId;
			const ask = approvals.options.find((option) => option.mode === "ask");
			if (ask) approvals.select(ask);
		}
	});
</script>

{#snippet shield(mode: SessionPermissionMode, size: number, detailed = true, knockout = "var(--color-bg-surface)")}
	<svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
		<path
			d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3z"
			stroke={detailed && mode === "full" ? "none" : "currentColor"}
			stroke-width="1.8"
			stroke-linejoin="round"
			fill={detailed && mode === "full" ? "currentColor" : "none"}
		/>
		{#if detailed}
			{#if mode === "dontAsk"}
				<path d="M9 12h6" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
			{:else if mode === "plan"}
				<path d="M9.3 9.6h5.4M9.3 12.4h5.4M9.3 15.2h3.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
			{:else if mode === "ask"}
				<path d="M10.1 10.2a1.95 1.95 0 113.2 1.5c-.75.55-1.3.95-1.3 2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" fill="none" />
				<circle cx="12" cy="16.2" r="1" fill="currentColor" />
			{:else if mode === "acceptEdits"}
				<path d="M9.4 15.4l.5-2.3 3.9-3.9 1.8 1.8-3.9 3.9z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" fill="none" />
			{:else if mode === "auto"}
				<path d="M12.9 7.9l-3.3 4.6h2.7l-.9 3.6 3.3-4.6h-2.7z" fill="currentColor" />
			{:else if mode === "full"}
				<path d="M12 8v4.7" stroke={knockout} stroke-width="2.2" stroke-linecap="round" />
				<circle cx="12" cy="15.9" r="1.2" fill={knockout} />
			{/if}
		{/if}
	</svg>
{/snippet}

{#if variant !== "icons" || !phone || hot}
<Menu
	bind:open
	ariaLabel="Approvals"
	side="top"
	align="end"
	sideOffset={4}
	class="w-[272px] font-sans"
	data-testid="permission-mode-dropdown"
>
	{#snippet trigger({ props })}
		{#if variant === "words"}
			<Button
				{...props}
				variant="ghost"
				size="content"
				tone="inherit"
				hoverFill="none"
				class="shrink-0 text-[11.5px] font-normal font-sans"
				style={`color: ${currentPresentation.tone}`}
				ariaLabel={`Approvals: ${currentLabel}. Open options`}
				loading={approvals.pending}
				data-testid="composer-word-approvals"
				title="Approvals ({currentLabel})"
			><span class="border-b border-dotted border-border-chip">{currentPresentation.microLabel.toLowerCase()}</span></Button>
		{:else if variant === "row"}
			<Button
				{...props}
				variant="ghost" size="content" tone="inherit" hoverFill="none" layout="flow"
				class="flex min-h-[50px] w-full items-center gap-[10px] rounded-none border-b border-border-subtle text-left text-[12.5px] font-normal font-sans text-text last:border-b-0 hover:bg-text/7"
				ariaLabel={`Approvals: ${currentLabel}. Open options`}
				loading={approvals.pending}
				data-testid="composer-more-mode"
			>
				<span data-part="label" class="w-[64px] shrink-0 text-[11px] text-text-muted">Mode</span>
				<span data-part="value" class="flex min-w-0 flex-1 items-center gap-[7px] font-semibold">{@render shield(currentMode, 13, false)}{currentLabel}</span>
				<span data-part="chevron" class="inline-flex shrink-0 text-text-dimmer"><Icon name="chevron-right" size={10} /></span>
			</Button>
		{:else if phone}
			<Button
				{...props}
				variant="ghost" size="content" tone="inherit" hoverFill="none"
				class="h-[26px] shrink-0 rounded-[7px] bg-warning/14 px-[6px] text-warning"
				ariaLabel={`Approvals: ${currentLabel}. Open options`}
				loading={approvals.pending}
				data-hot="true"
				data-testid="permission-mode-badge"
				title="Approvals ({currentLabel})"
			>
				{@render shield(currentMode, 13, false)}
			</Button>
		{:else}
			<Button
				{...props}
				variant="ghost"
				size="content"
				tone="inherit"
				hoverFill="none"
				class="h-[26px] shrink-0 gap-[5px] rounded-[7px] px-[6px] text-[11.5px] font-normal font-sans whitespace-nowrap {hot ? 'text-warning bg-warning/14' : 'text-text-secondary hover:bg-text/7'}"
				ariaLabel="Approvals {currentLabel}. Open options"
				loading={approvals.pending}
				data-hot={hot ? "true" : undefined}
				data-testid="permission-mode-badge"
				title="Approvals ({currentLabel})"
			>
				{@render shield(currentMode, 12, false)}
				{#if sessionViewState.composerTier === "wide"}<span data-testid="composer-mode-label">{currentLabel}</span>{/if}
			</Button>
		{/if}
	{/snippet}

	<MenuRadioGroup value={currentMode}>
		{#each availableModes as option (option.mode)}
			<MenuRadioItem
				value={option.mode}
				disabled={approvals.pending}
				data-testid="permission-mode-option-{option.mode}"
				onselect={() => { approvals.select(option); open = false; }}
			>
				<span class="grid grid-cols-[28px_minmax(0,1fr)] items-center gap-x-1.5">
					<span class="{presentation[option.mode].glyphClass} row-span-2 flex justify-center" aria-hidden="true">
						{@render shield(option.mode, 19)}
					</span>
					<span class="flex items-center gap-1.5 text-[12.5px] font-semibold">
						{option.label}
						{#if option.claudeOnly && discoveryState.currentTraits?.permissionModes.includes(option.mode)}
							<Badge variant="neutral" size="xs">{getProviderPresentation(discoveryState.currentDriver)?.label}</Badge>
						{/if}
					</span>
					<span class="truncate text-[10.5px] leading-[1.3] text-text-muted">{presentation[option.mode].description}</span>
				</span>
			</MenuRadioItem>
		{/each}
	</MenuRadioGroup>
</Menu>
{/if}
