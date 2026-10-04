<!--
  The collapsed phone header's line for banners, styled like the goal and
  background-task rows beside it. Like the phone tasks row it may widen the
  title column so the summary stays readable. It shows the first banner's summary and a
  count of the rest; tapping it opens the full header, where Banners shows
  every message with its actions. No chevron of its own: the island's expand
  chevron sits right beside it and does the same thing.
-->
<script lang="ts">
	import type { BannerConfig } from "../../types.js";
	import Button from "../ui/Button.svelte";
	import Icon from "../ui/Icon.svelte";
	import { bannerTone } from "./Banners.svelte";

	let { banners, onexpand }: { banners: readonly BannerConfig[]; onexpand: () => void } = $props();

	const first = $derived(banners[0]);
	const label = $derived(first?.summary ?? first?.text ?? "");
</script>

{#if first}
<Button variant="ghost" size="content" layout="flow" tone="inherit" hoverFill="none" data-testid="session-bar-banners-row" aria-controls="session-bar" aria-expanded={false} ariaLabel={banners.length === 1 ? label : `${label}, and ${banners.length - 1} more`} title={first.text} class="flex items-center justify-start whitespace-nowrap select-none w-full gap-1.5 text-[11px] leading-[1.35] {bannerTone(first.variant)}" onclick={onexpand}>
	<Icon name={first.icon} size={12} class="shrink-0" />
	<span class="min-w-0 truncate">{label}</span>
	{#if banners.length > 1}<span data-testid="session-bar-banners-more" class="shrink-0 font-semibold">+{banners.length - 1}</span>{/if}
</Button>
{/if}
