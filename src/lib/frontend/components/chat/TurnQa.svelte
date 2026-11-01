<script lang="ts">
	import type { ToolMessage } from "../../types.js";
	import { permissionsState } from "../../stores/permissions.svelte.js";
	import { isOpenHandBack } from "../../utils/turns.js";
	import { renderMarkdown } from "../../utils/markdown.js";
	import PermissionCard from "../permissions/PermissionCard.svelte";
	import ToolFullDetail from "./ToolFullDetail.svelte";
	import ToolItem from "./ToolItem.svelte";

	let { handBacks, sessionId }: { handBacks: readonly ToolMessage[]; sessionId: string | undefined } = $props();
</script>

<section aria-label="Turn Q&A" class="flex flex-col gap-[16px] border-t border-border bg-bg px-[12px] py-[12px]">
	{#each handBacks as handBack (handBack.uuid)}
		<div data-qa-entry={handBack.uuid} tabindex="-1" class="focus:bg-selection focus:outline-none">
			<ToolFullDetail message={handBack}>
				{#snippet children(message: ToolMessage)}
					{#if message.name === "AskUserQuestion"}
						<ToolItem {message} />
					{:else}
						{@const permission = permissionsState.pendingPermissions.find((request) => request.sessionId === sessionId && request.toolUseId === message.id)}
						{#if isOpenHandBack(message) && permission}
							<PermissionCard request={permission} />
						{:else}
							{@const plan = typeof message.input === "object" && message.input !== null && "plan" in message.input ? message.input.plan : undefined}
							<h3 class="mb-[6px] text-[13px] font-medium text-text-secondary">Plan approval</h3>
							{#if typeof plan === "string"}<div class="md-content text-[13px] text-text-secondary">{@html renderMarkdown(plan)}</div>{/if}
							<p class="mt-[6px] text-[12px] text-text-muted">{message.result || "Waiting for approval…"}</p>
						{/if}
					{/if}
				{/snippet}
			</ToolFullDetail>
		</div>
	{/each}
</section>
