<!-- ─── Step: Certificate ─────────────────────────────────────────────────── -->
<!-- Setup step for installing HTTPS certificate.                            -->

<script lang="ts">
	import type { StatusVariant } from "../../utils/setup-utils.js";
	import StepHeader from "./StepHeader.svelte";
	import StatusBox from "./StatusBox.svelte";

	let {
		totalSteps,
		currentIdx,
		isIOS,
		isAndroid,
		certStatus,
		certMessage,
		onnextstep,
		onretryhttps,
	}: {
		totalSteps: number;
		currentIdx: number;
		isIOS: boolean;
		isAndroid: boolean;
		certStatus: StatusVariant;
		certMessage: string;
		onnextstep: () => void;
		onretryhttps: () => void;
	} = $props();
</script>

<div class="animate-fadeIn">
	<StepHeader
		{totalSteps}
		{currentIdx}
		title="Install certificate"
		description="Encrypt all traffic between this device and the relay. The certificate is generated locally and does not grant any additional access."
	/>

	<!-- Instruction 1: Download -->
	<div class="flex gap-3 mb-4">
		<div
			class="w-6 h-6 rounded-full bg-bg-alt text-text flex items-center justify-center font-bold text-xs shrink-0 mt-0.5"
		>
			1
		</div>
		<div class="text-sm leading-relaxed">
			Download the certificate.<br />
			<a
				class="inline-flex items-center justify-center gap-2 bg-accent text-bg no-underline px-6 py-3 rounded-xl font-semibold text-sm mt-2 hover:opacity-90 transition-opacity"
				href="/ca/download">Download Certificate</a
			>
		</div>
	</div>

	<!-- Platform-specific instructions -->
	{#if isIOS}
		<div class="flex gap-3 mb-4">
			<div
				class="w-6 h-6 rounded-full bg-bg-alt text-text flex items-center justify-center font-bold text-xs shrink-0 mt-0.5"
			>
				2
			</div>
			<div class="text-sm leading-relaxed">
				Open <b>Settings</b> and tap the
				<b>Profile Downloaded</b> banner to install.
				<div class="text-xs text-text-muted mt-1">
					If the banner is gone: Settings &gt; General &gt; VPN &
					Device Management
				</div>
			</div>
		</div>
		<div class="flex gap-3 mb-4">
			<div
				class="w-6 h-6 rounded-full bg-bg-alt text-text flex items-center justify-center font-bold text-xs shrink-0 mt-0.5"
			>
				3
			</div>
			<div class="text-sm leading-relaxed">
				Go to <b
					>Settings &gt; General &gt; About &gt; Certificate Trust
					Settings</b
				> and enable full trust.
			</div>
		</div>
	{:else if isAndroid}
		<div class="flex gap-3 mb-4">
			<div
				class="w-6 h-6 rounded-full bg-bg-alt text-text flex items-center justify-center font-bold text-xs shrink-0 mt-0.5"
			>
				2
			</div>
			<div class="text-sm leading-relaxed">
				Open the downloaded file, or go to <b
					>Settings &gt; Security &gt; Install a certificate &gt; CA
					certificate</b
				>.
				<div class="text-xs text-text-muted mt-1">
					Path may vary by device. Search "certificate" in Settings if
					needed.
				</div>
			</div>
		</div>
	{:else}
		<div class="flex gap-3 mb-4">
			<div
				class="w-6 h-6 rounded-full bg-bg-alt text-text flex items-center justify-center font-bold text-xs shrink-0 mt-0.5"
			>
				2
			</div>
			<div class="text-sm leading-relaxed">
				The certificate should be trusted automatically via mkcert. If
				your browser still shows a warning, run
				<code class="bg-code-bg px-1.5 py-0.5 rounded text-xs"
					>mkcert -install</code
				> on the host machine.
			</div>
		</div>
	{/if}

	<StatusBox status={certStatus} message={certMessage} />

	<!-- Actions -->
	<div class="flex gap-2 mt-5">
		{#if certStatus === "warn"}
			<button
				class="flex-1 inline-flex items-center justify-center gap-2 bg-transparent text-text px-6 py-3 rounded-xl font-semibold text-sm cursor-pointer font-sans border-[1.5px] border-border hover:border-text-muted transition-colors"
				onclick={onretryhttps}
			>
				Retry
			</button>
		{/if}
		<button
			class="flex-1 inline-flex items-center justify-center gap-2 bg-accent text-bg px-6 py-3 rounded-xl font-semibold text-sm border-none cursor-pointer font-sans hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-default"
			onclick={onnextstep}
			disabled={certStatus !== "ok"}
		>
			{certStatus === "ok"
				? "Next"
				: certStatus === "pending"
					? "Verifying..."
					: "Waiting for HTTPS..."}
		</button>
	</div>
</div>
