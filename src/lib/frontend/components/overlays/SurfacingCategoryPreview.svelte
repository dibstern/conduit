<script lang="ts">
	import type { CategorySetContents } from "../../../contracts/category-set.js";
	import type { CategoryTuningScore } from "../../../contracts/category-tuning.js";
	import { rpc } from "../../transport/ws-rpc-client.js";
	import Button from "../ui/Button.svelte";

	let { current, draft, valid, active }: { current: CategorySetContents; draft: CategorySetContents; valid: boolean; active: boolean } = $props();
	let baseline = $state<CategoryTuningScore | null>(null);
	let preview = $state<CategoryTuningScore | null>(null);
	let checking = $state(false);
	let testing = $state(false);
	let error = $state("");
	let retry = $state(0);
	let request = 0;
	let disposed = false;
	$effect(() => {
		void retry;
		const set = $state.snapshot(draft);
		const base = $state.snapshot(current);
		if (!active || !valid) return;
		const revision = ++request;
		error = "";
		checking = true;
		const timer = setTimeout(() => {
			void Promise.all([
				rpc("ScoreCategorySet", { set: base, estimateOnly: true }),
				rpc("ScoreCategorySet", { set, estimateOnly: true }),
			]).then(([before, after]) => {
				if (revision !== request || disposed) return;
				baseline = before;
				preview = after;
			}).catch(() => { if (revision === request && !disposed) error = "Could not preview this draft. Try again."; })
				.finally(() => { if (revision === request && !disposed) checking = false; });
		}, 500);
		return () => { clearTimeout(timer); request++; };
	});
	$effect(() => () => { disposed = true; });

	async function test(): Promise<void> {
		if (!valid || testing || checking) return;
		if (!preview) { retry++; return; }
		if (!preview.canTest || preview.requiredCalls === 0) return;
		const revision = request;
		testing = true;
		error = "";
		try {
			const result = await rpc("ScoreCategorySet", { set: draft });
			if (revision === request && !disposed) preview = result;
		} catch { if (revision === request && !disposed) error = "Could not test the draft. Try again."; }
		finally { if (!disposed) testing = false; }
	}
	const balanced = (score: CategoryTuningScore) => score.levels.filter((item) => item.level === "balanced" || item.level === "key").length;
	const key = (score: CategoryTuningScore) => score.levels.filter((item) => item.level === "key").length;
</script>

{#snippet change(before: number, after: number)}{before}{#if after !== before}{" "}<ins class="text-accent no-underline">→ {after}</ins>{/if}{/snippet}

<div class="mb-3 flex items-center gap-3 rounded-[12px] bg-settings-card py-[10px] pr-[10px] pl-[14px] text-[12.5px] leading-[1.45] text-text-secondary [&_b]:font-semibold [&_b]:text-text max-md:flex-wrap" data-testid="surfacing-category-preview" aria-live="polite">
	<div class="min-w-0 flex-1 max-md:basis-full">
		{#if !valid}Complete the category definitions to preview this draft.
		{:else if preview?.complete && preview.levels.length === 0}No judged messages yet, so there is nothing to preview this draft against.
		{:else if preview?.complete && baseline?.complete}
			Of the last {preview.levels.length} judged messages: Balanced shows <b>{@render change(balanced(baseline), balanced(preview))}</b> · Key {@render change(key(baseline), key(preview))} · agrees with <b>{@render change(baseline.agree, preview.agree)}</b> of {preview.total} corrections
		{:else if preview}{preview.unavailableReason ?? "Definitions changed, so Jev must re-judge the sample."}{#if preview.requiredCalls > 0}{" "}Testing uses {preview.requiredCalls} Jev calls; weights stay free.{/if}
		{:else if checking}Checking preview…{/if}
		{#if error}<p role="alert" class="text-error">{error}</p>{/if}
	</div>
	<Button size="sm" data-testid="surfacing-category-preview-test" title={preview && preview.requiredCalls === 0 ? "Weights are scored for free. Change a definition to test against Jev." : undefined} disabled={!valid || checking || testing || (preview ? preview.requiredCalls === 0 || !preview.canTest : !error)} onclick={() => { void test(); }}>{testing ? "Testing…" : !preview && error ? "Retry" : "Test against my corrections"}</Button>
</div>
