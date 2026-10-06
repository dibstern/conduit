<!-- Session approvals: tap to cycle on phones, hold for the ranked menu. -->

<script lang="ts">
	import Badge from "../ui/Badge.svelte";
	import Menu from "../ui/Menu.svelte";
	import MenuRadioGroup from "../ui/MenuRadioGroup.svelte";
	import MenuRadioItem from "../ui/MenuRadioItem.svelte";
	import MicroLabelButton from "../ui/MicroLabelButton.svelte";
	import {
		approvals,
		getRankedApprovalOptions,
	} from "../../stores/composer-settings.svelte.js";
	import { discoveryState } from "../../stores/discovery.svelte.js";
	import type { SessionPermissionMode } from "../../types.js";

	let { variant = "icons" }: { variant?: "icons" | "words" | undefined } = $props();

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

	let innerWidth = $state(window.innerWidth);
	const phone = $derived(innerWidth < 768);
	let open = $state(false);
	let autoNormalizationProvider: string | null = null;

	const currentMode = $derived(approvals.current?.mode ?? "ask");
	const currentLabel = $derived(approvals.current?.label ?? "Ask");
	const currentPresentation = $derived(presentation[currentMode]);
	const availableModes = $derived(getRankedApprovalOptions());
	const isElevated = $derived(approvals.current?.elevated === true);

	$effect(() => {
		const providerId = discoveryState.currentProviderId;
		if (providerId === "claude") {
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

<svelte:window bind:innerWidth />

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

<Menu
	bind:open
	ariaLabel="Approvals"
	side="top"
	align="end"
	sideOffset={4}
	class="w-[272px] font-brand"
	data-testid="permission-mode-dropdown"
>
	{#snippet trigger({ props })}
		{#if phone || variant === "words"}
			<!-- Keep Bits' trigger attributes; its activation handlers would open
			     the menu before the tap/hold control can decide the action. -->
			<MicroLabelButton
				{...props}
				onpointerdown={undefined}
				onpointerup={undefined}
				onkeydown={undefined}
				variant={variant === "words" ? "words" : "micro"}
				label={variant === "words" ? currentPresentation.microLabel.toLowerCase() : currentPresentation.microLabel}
				accessibleName="Approvals {currentLabel}. Activate to cycle; hold or Shift+F10 opens options"
				tone={currentPresentation.tone}
				tinted={variant === "icons" && isElevated}
				pending={approvals.pending}
				pulseKey={currentMode}
				onTap={approvals.cycle}
				onHold={() => { open = true; }}
				data-testid={variant === "words" ? "composer-word-approvals" : "permission-mode-badge"}
				title="Approvals ({currentLabel})"
			>
				{#if variant === "icons"}{@render shield(currentMode, 15, false)}{/if}
			</MicroLabelButton>
		{:else}
			<MicroLabelButton
				{...props}
				variant="chip"
				onpointerdown={undefined}
				onpointerup={undefined}
				label={currentLabel}
				accessibleName="Approvals {currentLabel}. Open options"
				tone={currentPresentation.tone}
				pending={approvals.pending}
				pulseKey={currentMode}
				onTap={() => { open = true; }}
				onHold={() => { open = true; }}
				data-testid="permission-mode-badge"
				title="Approvals ({currentLabel})"
			>
				{@render shield(currentMode, 15, true, "var(--color-input-bg)")}
			</MicroLabelButton>
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
						{#if option.claudeOnly && discoveryState.currentProviderId === "claude"}
							<Badge variant="neutral" size="xs">Claude</Badge>
						{/if}
					</span>
					<span class="truncate text-[10.5px] leading-[1.3] text-text-muted">{presentation[option.mode].description}</span>
				</span>
			</MenuRadioItem>
		{/each}
	</MenuRadioGroup>
</Menu>
