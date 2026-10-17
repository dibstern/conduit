<script lang="ts">
	import type { Snippet } from "svelte";
	import type { HTMLAttributes } from "svelte/elements";
	import Icon from "./Icon.svelte";

	let { tone = "danger", icon, children, class: className, ...rest }: {
		tone?: "danger" | "warning" | "neutral";
		icon?: string;
		children: Snippet;
	} & HTMLAttributes<HTMLDivElement> = $props();
	const tint = $derived(tone === "danger" ? "var(--color-error)" : tone === "warning" ? "var(--color-warning)" : "var(--color-text-secondary)");
</script>

<div
	{...rest}
	class={["flex gap-[10px] rounded-[12px] px-[14px] py-[11px] text-[13px] leading-[1.45] text-text-secondary max-md:text-[13.5px] [&_b]:font-semibold [&_b]:text-text", className].filter(Boolean).join(" ")}
	style:background="color-mix(in srgb, {tint} 11%, var(--color-settings-card))"
>
	<span aria-hidden="true" class="mt-[2px] shrink-0" style:color={tint}><Icon name={icon ?? (tone === "danger" ? "timer" : tone === "warning" ? "triangle-alert" : "info")} size={16} /></span>
	<div class="min-w-0">{@render children()}</div>
</div>
