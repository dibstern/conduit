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

<!-- Keep the link full width and overlay the separate discard button on its time slot. -->
<div class="group relative" data-testid="draft-row" data-draft-id={draft.draftId}>
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
		<span class="col-start-3 row-start-1 whitespace-nowrap font-mono text-[11px] text-text-dimmer tabular-nums pointer-coarse:invisible pointer-coarse:min-w-[34px] pointer-fine:group-hover:invisible pointer-fine:group-focus-within:invisible">{timeText}</span>
		<span class="col-start-2 col-span-2 row-start-2 flex min-w-0 items-center gap-[5px] text-[12.5px] md:text-[11.5px] leading-[17px] text-text-dimmer font-sans pointer-coarse:pr-[34px]">
			<ProjectMark accent={projectAccent} />
			<span class="truncate">{projectLabel}</span>
		</span>
	</SessionRow>
	<Button
		variant="ghost" size="content" iconOnly tone="inherit" icon="trash-2" iconSize={14} ariaLabel="Discard draft" data-testid="draft-row-discard"
		class="absolute right-0 top-1/2 size-[44px] -translate-y-1/2 rounded-[9px] text-text-muted hover:text-error pointer-fine:right-[5px] pointer-fine:top-[5px] pointer-fine:size-[22px] pointer-fine:translate-y-0 pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:group-focus-within:opacity-100"
		onclick={() => ondiscard?.()}
	/>
</div>
