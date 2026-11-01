<!-- Session approvals: controls open Permissions in the Session panel. -->

<script lang="ts">
	import ComposerModeControl from "../ui/ComposerModeControl.svelte";
	import { approvals } from "../../stores/composer-settings.svelte.js";
	import { composerPickerState, openPicker } from "../../stores/composer-picker.svelte.js";
	import { discoveryState } from "../../stores/discovery.svelte.js";
	import { PERMISSION_MODE_LABELS } from "../../permission-modes.js";

	let { variant = "icons" }: { variant?: "icons" | "words" | "summary" | undefined } = $props();

	let autoNormalizationProvider: string | null = null;

	const currentMode = $derived(approvals.current?.mode ?? "ask");
	const currentLabel = $derived(PERMISSION_MODE_LABELS[currentMode]);

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
	<ComposerModeControl
		mode={currentMode}
		label={currentLabel}
		{variant}
		loading={approvals.pending}
		data-hot={currentMode === "acceptEdits" || currentMode === "auto" || currentMode === "full" ? "true" : undefined}
		data-testid={variant === "words" ? "composer-word-approvals" : "permission-mode-badge"}
		aria-haspopup="dialog"
		aria-expanded={composerPickerState.request?.section === "permissions"}
		aria-controls={composerPickerState.request?.section === "permissions" ? "model-picker" : undefined}
		onclick={(event: MouseEvent) => {
			openPicker("permissions");
			if (composerPickerState.request && event.currentTarget instanceof HTMLElement) composerPickerState.request.opener = event.currentTarget;
		}}
	/>
{/if}
