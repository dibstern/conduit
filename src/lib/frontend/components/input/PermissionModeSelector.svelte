<!-- Session approvals: controls and sheet rows open the ranked mode menu. -->

<script lang="ts">
	import Badge from "../ui/Badge.svelte";
	import ComposerModeControl from "../ui/ComposerModeControl.svelte";
	import PermissionShield from "../ui/PermissionShield.svelte";
	import Menu from "../ui/Menu.svelte";
	import MenuRadioGroup from "../ui/MenuRadioGroup.svelte";
	import MenuRadioItem from "../ui/MenuRadioItem.svelte";
	import MenuSeparator from "../ui/MenuSeparator.svelte";
	import {
		approvals,
		getRankedApprovalOptions,
	} from "../../stores/composer-settings.svelte.js";
	import { discoveryState } from "../../stores/discovery.svelte.js";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import { getProviderPresentation } from "../../utils/provider-presentation.js";
	import type { SessionPermissionMode } from "../../types.js";

	let { variant = "icons" }: { variant?: "icons" | "words" | "row" | "summary" | undefined } = $props();

	const labels: Record<SessionPermissionMode, string> = {
		dontAsk: "Never ask",
		plan: "Plan",
		ask: "Ask before edits",
		acceptEdits: "Auto-accept edits",
		auto: "Auto",
		full: "Full access",
	};
	const descriptions: Record<SessionPermissionMode, string> = {
		dontAsk: "Denies anything not pre-approved",
		plan: "Reads and plans, changes nothing",
		ask: "The default",
		acceptEdits: "Still asks before commands",
		auto: "A model approves or denies each action",
		full: "Never asks. Use in a sandbox",
	};
	let open = $state(false);
	let autoNormalizationProvider: string | null = null;

	const currentMode = $derived(approvals.current?.mode ?? "ask");
	const currentLabel = $derived(labels[currentMode]);
	const availableModes = $derived(getRankedApprovalOptions());

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

{#if variant === "summary"}
	<ComposerModeControl mode={currentMode} label={currentLabel} variant="summary" />
{:else}
<Menu
	bind:open
	appearance="final"
	presentation={sessionViewState.compact ? "sheet" : "popover"}
	ariaLabel="Permissions"
	side="top"
	align="end"
	sideOffset={4}
	class="w-[292px] font-sans"
	data-testid="permission-mode-dropdown"
>
	{#snippet trigger({ props })}
		<ComposerModeControl
			{...props}
			mode={currentMode}
			label={currentLabel}
			{variant}
			loading={approvals.pending}
			data-hot={currentMode === "acceptEdits" || currentMode === "auto" || currentMode === "full" ? "true" : undefined}
			data-testid={variant === "words" ? "composer-word-approvals" : variant === "row" ? "composer-more-mode" : "permission-mode-badge"}
		/>
	{/snippet}

	<MenuRadioGroup value={currentMode}>
		{#each availableModes as option (option.mode)}
			{#if option.mode === "full"}<MenuSeparator />{/if}
			<MenuRadioItem
				value={option.mode}
				disabled={approvals.pending}
				data-testid="permission-mode-option-{option.mode}"
				class="data-[state=checked]:bg-accent/14 data-[state=checked]:text-text!"
				onselect={() => { approvals.select(option); open = false; }}
			>
				<span class="grid grid-cols-[28px_minmax(0,1fr)] items-center gap-x-1.5">
					<span class="row-span-2 flex justify-center" aria-hidden="true">
						<PermissionShield mode={option.mode} size={19} />
					</span>
					<span class="flex items-center gap-1.5 text-[12.5px] font-semibold">
						{labels[option.mode]}
						{#if option.claudeOnly && discoveryState.currentTraits?.permissionModes.includes(option.mode)}
							<Badge variant="neutral" size="xs">{getProviderPresentation(discoveryState.currentDriver)?.label}</Badge>
						{/if}
					</span>
					<span class="truncate text-[10.5px] leading-[1.3] text-text-muted">{descriptions[option.mode]}</span>
				</span>
			</MenuRadioItem>
		{/each}
	</MenuRadioGroup>
</Menu>
{/if}
