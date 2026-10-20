<script lang="ts">
	import Badge from "../Badge.svelte";
	import Button from "../Button.svelte";
	import Icon from "../Icon.svelte";
	import ProjectMark from "../ProjectMark.svelte";
	import SearchInput from "../SearchInput.svelte";
	import SessionStatusGlyph from "../SessionStatusGlyph.svelte";
	import SessionRow from "../SessionRow.svelte";
</script>

<div class="flex w-[300px] flex-col gap-[14px] bg-sidebar-bg p-[12px] font-sans">
	<div class="flex items-center gap-[6px]">
		<Button variant="field" size="content" touchTarget>All projects <Icon name="chevron-down" size={12} /></Button>
		<SearchInput aria-label="Search sessions" placeholder="Search" shortcut="⌘K" />
	</div>
	<div class="flex gap-[5px]">
		<Button variant="filter" size="content" touchTarget aria-pressed>Needs you <span class="font-mono text-[11px]">2</span></Button>
		<Button variant="filter" size="content" touchTarget aria-pressed={false}>Running <span class="font-mono text-[11px]">2</span></Button>
	</div>
	<div class="flex gap-[12px]">
		{#each ["needs-approval", "needs-reply", "working", "monitoring", "done-unread", "error", "idle"] as attention}
			<SessionStatusGlyph attention={attention as import("../../../types.js").SessionAttention} />
		{/each}
		<SessionStatusGlyph settled /><SessionStatusGlyph snoozed />
	</div>
	<SessionRow href="#" active>
		<SessionStatusGlyph attention="needs-approval" />
		<span class="min-w-0 truncate font-medium text-text">Fix token refresh race</span>
		<Badge variant="ask" size="status" shape="pill">Approve</Badge>
		<span class="col-start-2 col-span-2 flex items-center gap-[5px] text-[11.5px] text-text-dimmer"><ProjectMark />conduit <code class="font-mono text-[11px]">fix/token-refresh</code></span>
	</SessionRow>
	<div class="flex gap-[2px]">
		{#each ["check", "moon", "pin", "pin-off", "ellipsis"] as icon}
			<Button variant="ghost" size="row-action" tone="secondary" hoverFill="sidebar" iconOnly {icon} iconSize={13} ariaLabel={icon} />
		{/each}
	</div>
</div>
