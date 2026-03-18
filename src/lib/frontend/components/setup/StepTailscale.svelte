<!-- ─── Step: Tailscale ───────────────────────────────────────────────────── -->
<!-- Setup step for connecting via Tailscale VPN.                            -->

<script lang="ts">
	import type { StatusVariant } from "../../utils/setup-utils.js";
	import StepHeader from "./StepHeader.svelte";
	import StatusBox from "./StatusBox.svelte";

	let {
		totalSteps,
		currentIdx,
		isIOS,
		isAndroid,
		tailscaleUrlHint,
		tsStatus,
		tsMessage,
		onnextstep,
	}: {
		totalSteps: number;
		currentIdx: number;
		isIOS: boolean;
		isAndroid: boolean;
		tailscaleUrlHint: string;
		tsStatus: StatusVariant;
		tsMessage: string;
		onnextstep: () => void;
	} = $props();
</script>

<div class="animate-fadeIn">
	<StepHeader
		{totalSteps}
		{currentIdx}
		title="Connect via Tailscale"
		description="Tailscale creates a private VPN so you can access OpenCode Relay from anywhere. It needs to be installed on both the server (the machine running OpenCode Relay) and this device."
	/>

	<!-- Instruction 1 -->
	<div class="flex gap-3 mb-4">
		<div
			class="w-6 h-6 rounded-full bg-bg-alt text-text flex items-center justify-center font-bold text-xs shrink-0 mt-0.5"
		>
			1
		</div>
		<div class="text-sm leading-relaxed">
			<b>Server:</b> Install Tailscale on the machine running OpenCode Relay.
			<div class="text-xs text-text-muted mt-1">
				If you are viewing this page, the server likely already has
				Tailscale. You can verify by checking its 100.x.x.x IP.
			</div>
		</div>
	</div>

	<!-- Instruction 2 -->
	<div class="flex gap-3 mb-4">
		<div
			class="w-6 h-6 rounded-full bg-bg-alt text-text flex items-center justify-center font-bold text-xs shrink-0 mt-0.5"
		>
			2
		</div>
		<div class="text-sm leading-relaxed">
			<b>This device:</b> Install Tailscale here and sign in with the same
			account.
			{#if isIOS}
				<div class="mt-2">
					<a
						class="inline-flex items-center justify-center gap-2 bg-accent text-bg no-underline px-6 py-3 rounded-xl font-semibold text-sm hover:opacity-90 transition-opacity"
						href="https://apps.apple.com/app/tailscale/id1470499037"
						target="_blank"
						rel="noopener">App Store</a
					>
				</div>
			{:else if isAndroid}
				<div class="mt-2">
					<a
						class="inline-flex items-center justify-center gap-2 bg-accent text-bg no-underline px-6 py-3 rounded-xl font-semibold text-sm hover:opacity-90 transition-opacity"
						href="https://play.google.com/store/apps/details?id=com.tailscale.ipn"
						target="_blank"
						rel="noopener">Google Play</a
					>
				</div>
			{:else}
				<div class="mt-2">
					<a
						class="inline-flex items-center justify-center gap-2 bg-accent text-bg no-underline px-6 py-3 rounded-xl font-semibold text-sm hover:opacity-90 transition-opacity"
						href="https://tailscale.com/download"
						target="_blank"
						rel="noopener">Download Tailscale</a
					>
				</div>
			{/if}
		</div>
	</div>

	<!-- Instruction 3 -->
	<div class="flex gap-3 mb-4">
		<div
			class="w-6 h-6 rounded-full bg-bg-alt text-text flex items-center justify-center font-bold text-xs shrink-0 mt-0.5"
		>
			3
		</div>
		<div class="text-sm leading-relaxed">
			Once both devices are on Tailscale, open the relay using the
			server's Tailscale IP.
			{#if tailscaleUrlHint}
				<div class="text-xs text-text-muted mt-1">
					{tailscaleUrlHint}
				</div>
			{/if}
		</div>
	</div>

	<StatusBox status={tsStatus} message={tsMessage} />

	<!-- Actions -->
	<div class="flex gap-2 mt-5">
		<button
			class="flex-1 inline-flex items-center justify-center gap-2 bg-accent text-bg px-6 py-3 rounded-xl font-semibold text-sm border-none cursor-pointer font-sans hover:opacity-90 transition-opacity"
			onclick={onnextstep}
		>
			Next
		</button>
	</div>
</div>
