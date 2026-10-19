<script lang="ts">
	import type { DraftListItem } from "../../types.js";
	import { formatTimeAgo } from "../../utils/format.js";
	import Button from "../ui/Button.svelte";
	import Icon from "../ui/Icon.svelte";
	import ProjectSquare from "./ProjectSquare.svelte";

	let { draft, href, projectLabel, projectAccent = 1, active = false, now = Date.now(), onopen, ondiscard }: {
		draft: DraftListItem;
		href: string;
		projectLabel: string;
		projectAccent?: number;
		active?: boolean;
		now?: number;
		onopen?: () => void;
		ondiscard?: () => void;
	} = $props();
	const title = $derived(draft.firstLine.trim() || "Untitled draft");
</script>

<div class="group flex items-center gap-1" data-testid="draft-row" data-draft-id={draft.draftId}>
	<Button
		{href} variant="ghost" size="content" layout="flow"
		class="grid min-w-0 flex-1 grid-cols-[16px_minmax(0,1fr)] items-center gap-x-2.5 rounded-panel px-2 py-1.5 min-h-[52px] md:min-h-[46px] font-brand {active ? 'bg-bg-alt' : ''}"
		ariaLabel="Draft: {title}, {projectLabel}" aria-current={active ? "page" : undefined}
		onclick={(event) => {
			if (!onopen || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
			event.preventDefault();
			onopen();
		}}
	>
		<span class="row-span-2 text-text-muted"><Icon name="pencil-line" size={16} /></span>
		<span class="truncate text-base italic" title={title}>{title}</span>
		<span class="flex min-w-0 items-center gap-1.5 text-sm text-text-dimmer">
			<ProjectSquare label={projectLabel} accent={projectAccent} />
			<span class="truncate">{projectLabel}</span>
			<span class="ml-auto shrink-0 text-xs tabular-nums">{formatTimeAgo(draft.updatedAt, new Date(now))}</span>
		</span>
	</Button>
	<Button variant="ghost" size="content" iconOnly tone="dimmer" icon="trash-2" iconSize={14} ariaLabel="Discard draft" data-testid="draft-row-discard" class="size-[44px] md:size-8 shrink-0 rounded-panel pointer-fine:opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity" onclick={() => ondiscard?.()} />
</div>
