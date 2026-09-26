<script lang="ts">
	import { formatSnoozeTime } from "../../utils/format.js";
	import { getSnoozePresets } from "../../utils/snooze.js";
	import Button from "../ui/Button.svelte";
	import Modal from "../ui/Modal.svelte";
	import TextInput from "../ui/TextInput.svelte";

	let {
		open,
		sessionTitle,
		now = Date.now(),
		onclose,
		onsnooze,
	}: {
		open: boolean;
		sessionTitle: string;
		now?: number;
		onclose: () => void;
		onsnooze: (until: number | null) => void;
	} = $props();

	let picking = $state(false);
	let pickedValue = $state("");
	const pickedUntil = $derived(new Date(pickedValue).getTime());
	const canPick = $derived(Number.isFinite(pickedUntil) && pickedUntil > now);
	const presets = $derived(getSnoozePresets(now));

	function select(until: number | null) {
		onsnooze(until);
		onclose();
	}
</script>

<Modal {open} {onclose} title="Snooze until…" description={sessionTitle || "New Session"} size="sm">
	<div class="flex flex-col gap-1 font-brand">
		{#each presets.filter((preset) => preset.id !== "indefinite") as preset (preset.id)}
			<Button
				variant="ghost"
				size="content"
				align="between"
				class="w-full rounded-lg px-3 py-2 text-sm"
				data-testid={`snooze-option-${preset.id}`}
				onclick={() => select(preset.until)}
			>
				<span>{preset.label}</span>
				<span class="text-text-dimmer">{formatSnoozeTime(preset.until, now)}</span>
			</Button>
		{/each}
		<Button
			variant="ghost"
			size="content"
			align="between"
			class="w-full rounded-lg px-3 py-2 text-sm"
			data-testid="snooze-option-pick"
			onclick={() => { picking = !picking; }}
		>
			Pick a date &amp; time…
		</Button>
		{#if picking}
			<div class="flex flex-col gap-2 px-3 pb-2">
				<TextInput
					type="datetime-local"
					aria-label="Snooze date and time"
					data-testid="snooze-pick-input"
					bind:value={pickedValue}
				/>
				<Button
					variant="primary"
					size="sm"
					data-testid="snooze-pick-submit"
					disabled={!canPick}
					onclick={() => { if (canPick) select(pickedUntil); }}
				>Snooze</Button>
			</div>
		{/if}
		<Button
			variant="ghost"
			size="content"
			align="between"
			class="w-full rounded-lg px-3 py-2 text-sm"
			data-testid="snooze-option-indefinite"
			onclick={() => select(null)}
		>
			<span>Until something happens</span>
			<span class="text-text-dimmer">No timer</span>
		</Button>
	</div>
</Modal>
