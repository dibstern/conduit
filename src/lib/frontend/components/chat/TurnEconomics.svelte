<!-- ─── Turn Economics ──────────────────────────────────────────────────────── -->
<!-- What the turn cost: cost · tokens in/out · how full the context was when it  -->
<!-- finished. The context gauge is absent, not zeroed, when the provider reports -->
<!-- no window.                                                                   -->
<!--                                                                              -->
<!-- This sits beside the activity strip on one line, so as the ledger narrows it  -->
<!-- sheds detail in a fixed order rather than wrapping or starving the strip:     -->
<!-- the gauge goes first, then the token counts. Cost is the last to survive —    -->
<!-- it is the shortest and the one worth reading. The queries measure the         -->
<!-- ledger, not the viewport, because a sidebar narrows the transcript on a wide  -->
<!-- screen just as a phone does.                                                  -->
<script lang="ts">
	import { fmtTokens, type TurnEconomics } from "../../utils/turns.js";

	let { economics }: { economics: TurnEconomics } = $props();

	const ctx = $derived(economics.context);
	const gaugeClass = $derived(
		ctx === undefined ? "" : ctx.pct >= 80 ? "bg-error" : ctx.pct >= 60 ? "bg-thinking" : "bg-brand-b",
	);
</script>

<span
	class="inline-flex items-center gap-2 font-mono text-xs text-text-dimmer whitespace-nowrap [&>span+span]:before:content-['·'] [&>span+span]:before:mr-2"
>
	{#if economics.cost !== undefined}<span>${economics.cost.toFixed(4)}</span>{/if}
	<!-- Each counter stands on its own: a provider that reports one and not the
	     other must not have a zero invented for the missing half. -->
	{#if economics.tokensIn !== undefined}
		<span class="@max-[336px]:hidden" title="Fresh input tokens">{fmtTokens(economics.tokensIn)} in</span>
	{/if}
	{#if economics.tokensOut !== undefined}
		<span class="@max-[336px]:hidden" title="Output tokens">{fmtTokens(economics.tokensOut)} out</span>
	{/if}
	{#if ctx}
		<span
			class="inline-flex items-center gap-1.5 @max-[432px]:hidden"
			title="{fmtTokens(ctx.used)} of {fmtTokens(ctx.window)} tokens in context when this turn finished"
		>
			<span>ctx</span>
			<span class="inline-block w-10 h-1 rounded-full bg-[rgba(var(--overlay-rgb),0.12)] overflow-hidden">
				<span class="block h-full rounded-full {gaugeClass}" style="width: {ctx.pct}%"></span>
			</span>
			<span>{ctx.pct}%</span>
		</span>
	{/if}
</span>
