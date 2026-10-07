<!--
  TranscriptDivider — a one-line record in the transcript: a centred mono
  caption between two hairlines, for moments that are not messages (a session
  resumed, or continued on another account).

  The caption is a content slot because each moment words itself differently.
  A `<b>` inside it is the account-name slot and wears the cyan emphasis, so
  call sites mark the name rather than colour it. A long caption truncates
  instead of pushing the hairlines off the row.
-->
<script lang="ts">
	import type { Snippet } from "svelte";
	import type { HTMLAttributes } from "svelte/elements";

	let {
		children,
		class: className = "",
		...rest
	}: { children: Snippet; class?: string } & Omit<HTMLAttributes<HTMLDivElement>, "class" | "children"> = $props();
</script>

<div
	{...rest}
	class="flex items-center gap-[8px] my-[12px] font-mono text-[10.5px] text-text-muted before:h-px before:flex-1 before:bg-border before:content-[''] after:h-px after:flex-1 after:bg-border after:content-[''] {className}"
>
	<span class="min-w-0 truncate [&_b]:font-semibold [&_b]:text-brand-b">{@render children()}</span>
</div>
