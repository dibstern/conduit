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

<!-- The discard button can't nest inside the link, so it overlays the time slot: the row keeps the
     full tray width, and on fine pointers the trash replaces the time on hover, as session rows do. -->
<div class="group relative" data-testid="draft-row" data-draft-id={draft.draftId}>
	<Button
		{href} variant="ghost" size="content" layout="flow" hoverFill="none"
		class="grid w-full grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-x-[10px] gap-y-px rounded-panel px-[8px] py-[6px] pointer-coarse:pr-[44px] min-h-[52px] md:min-h-[46px] font-brand group-hover:bg-text/5 {active ? 'bg-bg-alt' : ''}"
		ariaLabel="Draft: {title}, {projectLabel}" aria-current={active ? "page" : undefined}
		onclick={(event) => {
			if (!onopen || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
			event.preventDefault();
			onopen();
		}}
	>
		<span class="grid place-items-center text-text-dimmer"><Icon name="pencil-line" size={14} /></span>
		<span class="truncate text-base italic text-text-muted" title={title}>{title}</span>
		<span class="text-xs tabular-nums text-text-dimmer pointer-fine:group-hover:invisible pointer-fine:group-focus-within:invisible">{formatTimeAgo(draft.updatedAt, new Date(now))}</span>
		<span class="col-span-2 col-start-2 flex min-w-0 items-center gap-1.5 text-sm text-text-dimmer">
			<ProjectSquare label={projectLabel} accent={projectAccent} />
			<span class="truncate">{projectLabel}</span>
		</span>
	</Button>
	<Button
		variant="ghost" size="content" iconOnly tone="inherit" icon="trash-2" iconSize={14} ariaLabel="Discard draft" data-testid="draft-row-discard"
		class="absolute right-0 top-1/2 size-[44px] -translate-y-1/2 rounded-[6px] text-text-muted hover:text-error pointer-fine:right-[5px] pointer-fine:top-[5px] pointer-fine:size-[22px] pointer-fine:translate-y-0 pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:group-focus-within:opacity-100"
		onclick={() => ondiscard?.()}
	/>
</div>
