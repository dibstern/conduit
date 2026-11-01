<script lang="ts">
	import { fmtClock, fmtTokens, skillName, toolSubject, type Turn, type TurnEconomics } from "../../utils/turns.js";
	import Badge from "../ui/Badge.svelte";
	import Icon from "../ui/Icon.svelte";
	import QuotaMeter from "../ui/QuotaMeter.svelte";

	let { turn, bill }: { turn: Turn; bill: TurnEconomics } = $props();
	const parts = $derived(turn.segments.flatMap((segment) => segment.activity));
	const skills = $derived(parts.flatMap((part) => part.type === "tool" && part.name === "Skill" ? [part] : []));
	const notable = $derived(parts.filter((part) => part.type === "system" || (part.type === "tool" && (part.status === "error" || part.isError))));
	const start = $derived(turn.user?.createdAt ?? parts[0]?.createdAt ?? 0);
</script>

<div role="region" aria-label="Turn usage" class="grid grid-cols-2 gap-x-[18px] gap-y-[14px] border-t border-border px-[18px] py-[14px] text-[12px] text-text-secondary">
	<div><h3 class="mb-[4px] text-[11.5px] text-text-muted">Cost</h3><p class="font-mono">{bill.cost === undefined ? "Not reported" : `$${bill.cost.toFixed(4)}`}</p></div>
	<div><h3 class="mb-[4px] text-[11.5px] text-text-muted">Tokens</h3><p class="font-mono">{bill.tokensIn === undefined ? "Input not reported" : `${fmtTokens(bill.tokensIn)} in`} · {bill.tokensOut === undefined ? "Output not reported" : `${fmtTokens(bill.tokensOut)} out`}</p></div>
	<div class="col-span-2">
		<h3 class="mb-[6px] text-[11.5px] text-text-muted">Context at end</h3>
		{#if bill.context}
			<QuotaMeter used={bill.context.pct} size="panel" caption={`${bill.context.pct}% · ${fmtTokens(bill.context.used)} / ${fmtTokens(bill.context.window)}`} />
		{:else}<p>{bill.contextWithoutCapacity === undefined ? "Not reported" : `${fmtTokens(bill.contextWithoutCapacity)} tokens · capacity not reported`}</p>{/if}
	</div>
	<div class="col-span-2">
		<h3 class="mb-[6px] text-[11.5px] text-text-muted">Skills loaded</h3>
		{#if skills.length}<ul class="space-y-[6px]">
			{#each skills as skill (skill.uuid)}<li class="flex items-center gap-[10px]"><Badge variant="skill" size="label" shape="pill"><Icon name="sparkles" size={12} /><span class="font-mono">{skillName(skill)}</span></Badge>{#if skill.createdAt !== undefined}<time class="ml-auto shrink-0 font-mono text-[11px] text-text-muted">at {fmtClock(skill.createdAt - start)}</time>{/if}</li>{/each}
		</ul>{:else}<p>None</p>{/if}
	</div>
	<div class="col-span-2">
		<h3 class="mb-[6px] text-[11.5px] text-text-muted">Worth a look</h3>
		{#if notable.length}<ul class="space-y-[6px]">
			{#each notable as part (part.uuid)}
				<li class="flex items-center gap-[8px]">
					{#if part.type === "tool"}<Icon name="circle-alert" size={14} class="shrink-0 text-error" /><span>1 failed step · <code>{toolSubject(part) || part.name}</code></span>
					{:else if part.type === "system"}<Icon name="minimize" size={14} class="shrink-0" /><span>Context compacted{#if part.preTokens !== undefined && part.postTokens !== undefined && part.preTokens > part.postTokens}{` · ${fmtTokens(part.preTokens - part.postTokens)} saved`}{/if}</span>{/if}
					{#if part.createdAt !== undefined}<time class="ml-auto shrink-0 font-mono text-[11px] text-text-muted">at {fmtClock(part.createdAt - start)}</time>{/if}
				</li>
			{/each}
		</ul>{:else}<p>None</p>{/if}
	</div>
</div>
