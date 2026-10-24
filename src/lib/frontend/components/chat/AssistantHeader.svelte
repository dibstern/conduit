<script lang="ts">
	import { onDestroy } from "svelte";
	import type { AssistantMessage, ModelExecution } from "../../types.js";
	import { getAllModels, getModelDisplayName, modelMatchesId } from "../../stores/discovery.svelte.js";
	import { copyToClipboard } from "../../utils/clipboard.js";
	import { selection } from "../../stores/selection.svelte.js";
	import { followFork, sessionState } from "../../stores/session.svelte.js";
	import { getCurrentSlug } from "../../stores/router.svelte.js";
	import { getBrowserClientId } from "../../stores/client-identity.js";
	import { rpc } from "../../transport/ws-rpc-client.js";
	import { toastFailure } from "../../transport/rpc-errors.js";
	import { getProviderPresentation } from "../../utils/provider-presentation.js";
	import { effortLevels } from "../model/effort-levels.js";
	import { resolveModelParameters } from "../model/model-parameters.js";
	import Button from "../ui/Button.svelte";
	import Icon from "../ui/Icon.svelte";
	import Menu from "../ui/Menu.svelte";
	import MenuItem from "../ui/MenuItem.svelte";
	import Tooltip from "../ui/Tooltip.svelte";
	import MessageTime from "./MessageTime.svelte";

	let {
		message,
		forkMessageId,
		sessionId,
		modelExecution,
		providerId,
		createdAt,
		copyState = $bindable("idle"),
	}: {
		message?: AssistantMessage | undefined;
		forkMessageId?: string | undefined;
		sessionId?: string | undefined;
		modelExecution?: ModelExecution | undefined;
		providerId?: string | undefined;
		createdAt?: number | undefined;
		copyState?: "idle" | "primed" | "done";
	} = $props();

	let menuOpen = $state(false);
	let copyResetTimer: ReturnType<typeof setTimeout> | undefined;
	const provider = $derived(getProviderPresentation(providerId));
	const model = $derived(modelExecution?.actualModel ?? modelExecution?.requestedModel);
	const title = $derived(model ? getModelDisplayName(model) : provider?.label ?? "Assistant");
	const context = $derived(modelExecution?.contextWindow === "1m" ? "1M" : modelExecution?.contextWindow);
	const effortValue = $derived.by(() => {
		const variant = modelExecution?.effort;
		if (!variant) return variant;
		const models = getAllModels();
		const catalog = models.find((entry) => modelMatchesId(entry, modelExecution?.actualModel))
			?? models.find((entry) => modelMatchesId(entry, modelExecution?.requestedModel));
		if (!catalog?.parameters) return variant;
		const parameters = resolveModelParameters(catalog, variant);
		return parameters.variantUnavailable ? variant : parameters.rows.find((row) => row.kind === "effort")?.value;
	});
	const effort = $derived(effortLevels.find((level) => level.value === effortValue)?.name ?? effortValue);
	const tooltip = $derived(context || effort ? [title, context, effort].filter(Boolean).join(" · ") : undefined);
	const copyLabel = $derived(copyState === "done" ? "Copied!" : copyState === "primed" ? "Click to confirm copy" : "Copy message");

	async function copyMessage() {
		if (!message || !await copyToClipboard(message.rawText)) return;
		copyState = "done";
		clearTimeout(copyResetTimer);
		copyResetTimer = setTimeout(() => { copyState = "idle"; }, 3000);
	}

	function forkMessage() {
		if (!forkMessageId) return;
		const projectSlug = getCurrentSlug();
		if (!projectSlug) return;
		const sourceSessionId = sessionId ?? sessionState.currentId;
		const from = selection.scope;
		void rpc("ForkSession", {
			...(sourceSessionId ? { sessionId: sourceSessionId } : { projectSlug }),
			originId: getBrowserClientId(),
			messageId: forkMessageId,
		}).then((response) => followFork(from, response)).catch(toastFailure("Failed to fork session"));
	}

	onDestroy(() => clearTimeout(copyResetTimer));
</script>

<div data-message-id={message?.messageId} class="assistant-header group/header grid grid-cols-[20px_minmax(0,1fr)] items-start gap-x-[8px] md:grid-cols-[28px_minmax(0,1fr)] md:gap-x-[14px]">
	<span aria-hidden="true" class="mt-[4px] grid size-[20px] place-items-center rounded-[6px] md:mt-0 md:size-[28px] md:rounded-[8px] {providerId === 'claude' ? 'bg-harness-claude text-white [&_g]:fill-current' : 'bg-bg-raised'}">
		<Icon name={provider?.logo ?? "bot"} size={providerId === "claude" ? 14 : 18} class={providerId === "claude" ? "size-[12px] md:size-[14px]" : ""} />
	</span>
	<div class="flex min-h-[28px] min-w-0 flex-wrap items-center gap-x-[8px] gap-y-[4px] text-[13.5px] font-semibold">
		<!-- Keep the title and time on the same baseline. -->
		<span class="flex min-w-0 items-baseline gap-x-[8px]">
			{#if tooltip}
				<Tooltip>
					{#snippet trigger({ props })}
						<span {...props} class="min-w-0 truncate">{title}</span>
					{/snippet}
					{tooltip}
				</Tooltip>
			{:else}
				<span class="min-w-0 truncate">{title}</span>
			{/if}
			{#if (createdAt ?? message?.createdAt) != null}
				<span aria-hidden="true" class="font-normal text-text-dimmer">·</span>
				<MessageTime createdAt={createdAt ?? message?.createdAt} />
			{/if}
		</span>
		{#if message?.finalized}
			<div class="msg-actions ml-auto flex items-center gap-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 group-hover/header:opacity-100 group-focus-within/header:opacity-100 touch:opacity-100" class:opacity-100={copyState !== "idle" || menuOpen}>
				<Button variant="ghost" size="content" tone={copyState === "done" ? "success" : "dimmer"} iconOnly icon={copyState === "done" ? "check" : "copy"} iconSize={14} touchTarget class="size-[26px]" title={copyLabel} ariaLabel={copyLabel} onclick={copyMessage} />
				{#if forkMessageId}
					<Button variant="ghost" size="content" tone="dimmer" iconOnly icon="git-fork" iconSize={14} touchTarget class="size-[26px]" title="Fork from here" ariaLabel="Fork from here" onclick={forkMessage} />
				{/if}
				<Menu bind:open={menuOpen} align="end" ariaLabel="Message actions">
					{#snippet trigger({ props })}
						<Button {...props} variant="ghost" size="content" tone="dimmer" iconOnly icon="ellipsis" iconSize={14} touchTarget class="size-[26px]" ariaLabel="More message actions" />
					{/snippet}
					<MenuItem onselect={copyMessage}>Copy message</MenuItem>
					{#if forkMessageId}<MenuItem onselect={forkMessage}>Fork from here</MenuItem>{/if}
				</Menu>
			</div>
		{/if}
	</div>
</div>
