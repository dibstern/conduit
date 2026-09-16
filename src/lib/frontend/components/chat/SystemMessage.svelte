<!-- ─── System Message ──────────────────────────────────────────────────────── -->
<!-- Displays system info/error messages with left-border accent. -->

<script lang="ts">
	import type { SystemMessage } from "../../types.js";
	import Icon from "../ui/Icon.svelte";
	import Surface from "../ui/Surface.svelte";

	let { message }: { message: SystemMessage } = $props();

	const isError = $derived(message.variant === "error");
	const hasDetails = $derived(
		!!(message.statusCode || (message.details && Object.keys(message.details).length > 0)),
	);

	let showDetails = $state(false);

	// The background is no longer here: both branches were bg-bg-surface, so it
	// is Surface's `plain` variant and only the foreground actually varies.
	const containerClasses = $derived(
		isError ? "glow-tool-error text-error" : "text-text-muted",
	);

	// Hover is an affordance, so the card only gets one when it actually holds
	// something to click. A card with no details is inert, and a hover response on
	// an inert card promises an interaction that does not exist. Ring rather than
	// border so nothing reflows (conduit-test-wzat).
	const hoverClasses = $derived(hasDetails ? "hover:ring-1 hover:ring-border" : "");
</script>

<div class="max-w-[760px] mx-auto my-2 px-5">
	<Surface
		variant="plain"
		padding="sm"
		class="flex flex-col gap-1 text-base {containerClasses} {hoverClasses}"
	>
		<div class="flex items-start gap-2">
			<span class="shrink-0 mt-0.5 [&_.lucide]:w-3 [&_.lucide]:h-3">
				{#if isError}
					<Icon name="circle-alert" size={12} />
				{:else}
					<Icon name="info" size={12} />
				{/if}
			</span>
			<div class="flex-1 min-w-0">
				<span>
					{#if message.errorCode}
						<span class="font-mono text-xs opacity-70 mr-1.5">{message.errorCode}</span>
					{/if}
					{message.text}
				</span>
				{#if hasDetails}
					<button
						class="ml-2 text-xs opacity-60 hover:opacity-100 cursor-pointer underline"
						onclick={() => showDetails = !showDetails}
					>
						{showDetails ? "Hide details" : "Show details"}
					</button>
				{/if}
			</div>
		</div>

		{#if showDetails && hasDetails}
			<div class="ml-5 mt-1 p-2 rounded bg-black/20 text-xs font-mono space-y-0.5 overflow-x-auto">
				{#if message.statusCode}
					<div><span class="opacity-60">status:</span> {message.statusCode}</div>
				{/if}
				{#if message.details}
					{#each Object.entries(message.details) as [key, value]}
						<div class="break-all">
							<span class="opacity-60">{key}:</span>
							{typeof value === "string" ? value : JSON.stringify(value)}
						</div>
					{/each}
				{/if}
			</div>
		{/if}
	</Surface>
</div>
