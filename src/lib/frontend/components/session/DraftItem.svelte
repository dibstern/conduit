<script lang="ts">
	import type { DraftListItem } from "../../types.js";
	import { formatTimeAgo } from "../../utils/format.js";
	import Button from "../ui/Button.svelte";
	import Icon from "../ui/Icon.svelte";
	import ProjectMark from "../ui/ProjectMark.svelte";
	import SessionRow from "../ui/SessionRow.svelte";

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
	const timeText = $derived(formatTimeAgo(draft.updatedAt, new Date(now))
		.replace(/ ago$/, "").replace("Yesterday", "1d").replace("just now", "now"));
</script>

<div class="group grid grid-cols-[minmax(0,1fr)_44px] md:grid-cols-[minmax(0,1fr)_32px] items-center" data-testid="draft-row" data-draft-id={draft.draftId}>
	<SessionRow
		{href} {active}
		aria-label="Draft: {title}, {projectLabel}" aria-current={active ? "page" : undefined}
		onclick={(event) => {
			if (!onopen || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
			event.preventDefault();
			onopen();
		}}
	>
		<span class="col-start-1 row-start-1 text-text-muted"><Icon name="pencil-line" size={14} /></span>
		<span class="col-start-2 row-start-1 min-w-0 truncate font-sans font-normal text-text-secondary" title={title}>{title}</span>
		<span class="col-start-3 row-start-1 whitespace-nowrap font-mono text-[11px] text-text-dimmer tabular-nums">{timeText}</span>
		<span class="col-start-2 col-span-2 row-start-2 flex min-w-0 items-center gap-[5px] text-[12.5px] md:text-[11.5px] leading-[17px] text-text-dimmer font-sans">
			<ProjectMark accent={projectAccent} />
			<span class="truncate">{projectLabel}</span>
		</span>
	</SessionRow>
	<Button variant="ghost" size="content" iconOnly tone="dimmer" icon="trash-2" iconSize={14} ariaLabel="Discard draft" data-testid="draft-row-discard" class="size-[44px] md:size-8 shrink-0 rounded-[9px] pointer-fine:opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity" onclick={() => ondiscard?.()} />
</div>
