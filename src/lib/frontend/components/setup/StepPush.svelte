<!-- ─── Step: Push Notifications ──────────────────────────────────────────── -->
<!-- Setup step for enabling push notifications.                              -->

<script lang="ts">
	import type { StatusVariant } from "../../utils/setup-utils.js";
	import StepHeader from "./StepHeader.svelte";

	let {
		totalSteps,
		currentIdx,
		pushNeedsHttps,
		pushEnabled,
		pushBusy,
		pushStatus,
		pushMessage,
		onnextstep,
		onenablepush,
	}: {
		totalSteps: number;
		currentIdx: number;
		pushNeedsHttps: boolean;
		pushEnabled: boolean;
		pushBusy: boolean;
		pushStatus: StatusVariant | null;
		pushMessage: string;
		onnextstep: () => void;
		onenablepush: () => void;
	} = $props();
</script>

<div class="animate-fadeIn">
	<StepHeader
		{totalSteps}
		{currentIdx}
		title="Enable notifications"
		description="Get alerted on your phone when OpenCode finishes a response, even when the app is in the background."
	/>

	{#if pushNeedsHttps}
		<div
		class="flex items-center gap-2 px-4 py-3 rounded-[10px] text-base my-4 bg-bg-alt text-text border border-border"
		>
			Push notifications require HTTPS. Complete the certificate step
			first.
		</div>
		<div class="flex gap-2 mt-5">
			<button
				class="w-full inline-flex items-center justify-center gap-2 bg-accent text-bg px-6 py-3 rounded-xl font-semibold text-sm border-none cursor-pointer font-sans hover:opacity-90 transition-opacity"
				onclick={onnextstep}
			>
				Finish anyway
			</button>
		</div>
	{:else if !pushEnabled}
		<button
			class="w-full inline-flex items-center justify-center gap-2 bg-accent text-bg px-6 py-3 rounded-xl font-semibold text-sm border-none cursor-pointer font-sans hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-default"
			onclick={onenablepush}
			disabled={pushBusy}
		>
			{pushBusy
				? "Requesting permission..."
				: "Enable Push Notifications"}
		</button>
	{/if}

	{#if pushStatus}
		{@const statusClasses =
			pushStatus === "ok"
				? "bg-success/10 text-success border-success/15"
				: "bg-bg-alt text-text border-border"}
		<div
			class="flex items-center gap-2 px-4 py-3 rounded-[10px] text-base my-4 {statusClasses}"
			style="border-width: 1px;"
		>
			{pushMessage}
		</div>
	{/if}

	{#if pushStatus === "warn"}
		<div class="flex gap-2 mt-5">
			<button
				class="w-full inline-flex items-center justify-center gap-2 bg-accent text-bg px-6 py-3 rounded-xl font-semibold text-sm border-none cursor-pointer font-sans hover:opacity-90 transition-opacity"
				onclick={onnextstep}
			>
				Finish anyway
			</button>
		</div>
	{/if}
</div>
