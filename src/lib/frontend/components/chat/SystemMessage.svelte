<!-- Displays system notices, using a tinted fill for failures. -->

<script lang="ts">
	import Button from "../ui/Button.svelte";
	import type { SystemMessage } from "../../types.js";
	import Icon from "../ui/Icon.svelte";
	import Surface from "../ui/Surface.svelte";
	import { getProviderPresentation } from "../../utils/provider-presentation.js";
	import { cursorAuth, openCursorLogin, refreshCursorAuth } from "../../stores/cursor-auth.svelte.js";

	let { message, driver }: { message: SystemMessage; driver?: string | undefined } = $props();
	const auth = $derived(getProviderPresentation(driver)?.auth);
	$effect(() => {
		if (auth && message.errorCode === auth.errorCode) void refreshCursorAuth();
	});

	const isError = $derived(message.variant === "error" || message.setup?.status === "failed" || message.setup?.status === "timed_out");
	const setupTitle = $derived.by(() => {
		switch (message.setup?.status) {
			case "running": return "Setup script running";
			case "succeeded": return "Setup script succeeded";
			case "failed": return `Setup script failed${message.setup.exitCode !== undefined ? ` (exit code ${message.setup.exitCode})` : ""}`;
			case "timed_out": return "Setup script timed out";
			case "skipped": return "Setup script skipped";
			default: return "Setup script";
		}
	});
	const setupIcon = $derived(message.setup ? {
		running: "loader-circle",
		succeeded: "circle-check",
		failed: "circle-alert",
		timed_out: "timer",
		skipped: "triangle-alert",
	}[message.setup.status] : "info");
	const setupTone = $derived(isError ? "text-error" : message.setup?.status === "succeeded" ? "text-success" : message.setup?.status === "skipped" ? "text-warning" : "text-text-muted");
	const hasDetails = $derived(
		!!(message.statusCode || (message.details && Object.keys(message.details).length > 0)),
	);

	let showDetails = $state(false);
	// Wired to the toggle's aria-controls: the details region is a sibling of the
	// button rather than a child, so nothing but an id connects the two.
	const detailsId = $props.id();

	const containerClasses = $derived(
		isError ? "bg-error/14 text-error" : "bg-bg-surface text-text-muted",
	);

	// Hover is an affordance, so the card only gets one when it actually holds
	// something to click. A card with no details is inert, and a hover response on
	// an inert card promises an interaction that does not exist. Ring rather than
	// border so nothing reflows.
	const hoverClasses = $derived(hasDetails ? "hover:ring-1 hover:ring-border" : "");
</script>

<div class="max-w-[760px] mx-auto my-2 px-5" data-testid={message.setup ? "session-setup-block" : undefined} data-setup-status={message.setup?.status} data-setup-source={message.setup?.source} role={message.setup ? "status" : undefined} aria-label={message.setup ? setupTitle : undefined}>
	<Surface
		variant="bare"
		padding="sm"
		class="system-notice flex flex-col gap-1 text-base {containerClasses} {hoverClasses}"
	>
		{#if message.setup}
			<div class="flex items-center gap-2 text-sm {setupTone}">
				<span aria-hidden="true"><Icon name={setupIcon} size={14} class={message.setup.status === "running" ? "animate-spin motion-reduce:animate-none" : ""} /></span>
				<strong class="font-medium">{setupTitle}</strong>
			</div>
			{#if message.setup.message}
				<p class="text-sm text-text-secondary break-words">{message.setup.message}</p>
			{/if}
			{#if message.setupOutput}
				<Surface variant="bare" padding="sm" class="mt-1 max-h-64 overflow-auto bg-code-bg">
					<pre class="whitespace-pre-wrap break-words font-mono text-mono-xs text-text-secondary">{message.setupOutput}</pre>
				</Surface>
			{/if}
		{:else}
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
					{#if auth && message.errorCode === auth.errorCode}
						<Button variant="ghost-accent" size="sm" class="ml-2" data-testid="provider-auth-login" onclick={openCursorLogin}>{cursorAuth.current && cursorAuth.current.source !== "environment" ? auth.login : auth.manage}</Button>
					{/if}
					{#if hasDetails}
						<Button
							variant="ghost"
							size="content"
							layout="flow"
							tone="inherit"
							hoverFill="none"
							class="ml-2 text-xs opacity-60 hover:opacity-100 underline"
							aria-expanded={showDetails}
							aria-controls={detailsId}
							onclick={() => showDetails = !showDetails}
						>
							{showDetails ? "Hide details" : "Show details"}
						</Button>
					{/if}
				</div>
			</div>

			{#if showDetails && hasDetails}
				<div
					id={detailsId}
					class="ml-5 mt-1 p-2 rounded bg-code-bg text-xs font-mono space-y-0.5 overflow-x-auto"
				>
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
		{/if}
	</Surface>
</div>
