<!-- ─── DiffView ────────────────────────────────────────────────────────────── -->
<!-- Renders a side-by-side or unified diff between two text inputs.            -->
<!-- Computes diff ops using the LCS-based diff utility and renders with        -->
<!-- proper line numbers, markers, and color-coded styling.                     -->

<script lang="ts">
	import { computeDiff, buildSplitRows, diffStats } from "../../utils/diff.js";
	import { escapeHtml } from "../../utils/format.js";
	import type { DiffOp, SplitRow } from "../../types.js";

	// ─── Props ──────────────────────────────────────────────────────────────────

	let {
		oldText,
		newText,
		filename,
	}: {
		oldText: string;
		newText: string;
		filename?: string;
	} = $props();

	// ─── Local state ────────────────────────────────────────────────────────────

	let viewMode = $state<"unified" | "split">("unified");

	// ─── Derived ────────────────────────────────────────────────────────────────

	const ops = $derived(computeDiff(oldText.split("\n"), newText.split("\n")));

	const splitRows = $derived(buildSplitRows(ops));

	const stats = $derived(diffStats(oldText, newText));

	// ─── Helpers ────────────────────────────────────────────────────────────────

	function lineClass(type: DiffOp["type"]): string {
		switch (type) {
			case "add":
			return "diff-line diff-add flex min-h-[20px] whitespace-pre bg-success/[0.08]";
		case "remove":
			return "diff-line diff-remove flex min-h-[20px] whitespace-pre bg-error/[0.08]";
			default:
				return "diff-line diff-equal flex min-h-[20px] whitespace-pre";
		}
	}

	function markerChar(type: DiffOp["type"]): string {
		if (type === "add") return "+";
		if (type === "remove") return "-";
		return "\u00a0";
	}

	function markerClass(type: DiffOp["type"]): string {
		const base =
			"diff-marker min-w-[20px] text-center shrink-0 font-semibold select-none";
		if (type === "add") return `${base} text-success`;
		if (type === "remove") return `${base} text-error`;
		return base;
	}

	function textClass(type: DiffOp["type"]): string {
		const base = "diff-text flex-1 pr-3";
		if (type === "add") return `${base} text-success`;
		if (type === "remove") return `${base} text-error`;
		return `${base} text-text-secondary`;
	}

	function splitRowClass(type: SplitRow["type"]): string {
		switch (type) {
			case "add":
				return "diff-row diff-add";
			case "remove":
				return "diff-row diff-remove";
			case "change":
				return "diff-row diff-change";
			default:
				return "diff-row diff-equal";
		}
	}
</script>

<div class="diff-container">
	<!-- Filename header -->
	{#if filename}
		<div
			class="diff-filename text-xs font-mono text-text-dimmer px-3 py-1.5 bg-code-bg border border-border-subtle border-b-0 rounded-t-lg"
		>
			{filename}
		</div>
	{/if}

	<!-- Diff stats -->
	<div class="diff-stats flex items-center gap-3 px-3 py-1.5 text-xs">
		{#if stats.additions > 0}
			<span class="text-success font-medium">+{stats.additions}</span>
		{/if}
		{#if stats.deletions > 0}
			<span class="text-error font-medium">-{stats.deletions}</span>
		{/if}
		{#if stats.additions === 0 && stats.deletions === 0}
			<span class="text-text-dimmer">No changes</span>
		{/if}
	</div>

	<!-- Toggle bar -->
	<div
		class="diff-toggle-bar flex items-center gap-1 px-3 py-1 mb-1"
	>
		<button
			class={"diff-toggle-btn text-xs px-2 py-1 rounded border cursor-pointer font-sans transition-colors duration-100 " + (viewMode === "unified" ? "bg-accent/20 border-accent/40 text-accent font-medium" : "bg-transparent border-border text-text-dimmer hover:text-text hover:border-border-subtle")}
			onclick={() => (viewMode = "unified")}
		>
			Unified
		</button>
		<button
			class={"diff-toggle-btn text-xs px-2 py-1 rounded border cursor-pointer font-sans transition-colors duration-100 " + (viewMode === "split" ? "bg-accent/20 border-accent/40 text-accent font-medium" : "bg-transparent border-border text-text-dimmer hover:text-text hover:border-border-subtle")}
			onclick={() => (viewMode = "split")}
		>
			Split
		</button>
	</div>

	<!-- Unified view -->
	{#if viewMode === "unified"}
		<div
			class={"diff-viewer font-mono text-xs leading-normal overflow-x-auto bg-code-bg border border-border-subtle" + (filename ? " rounded-b-lg" : " rounded-lg")}
		>
			{#each ops as op (op.type + "-" + (op.oldLineNo ?? "") + "-" + (op.newLineNo ?? ""))}
				<div class={lineClass(op.type)}>
					<span
						class="diff-gutter diff-gutter-old min-w-[40px] px-2 text-right text-text-dimmer select-none shrink-0 text-sm border-r border-border-subtle"
					>
						{op.type !== "add" ? (op.oldLineNo ?? "") : ""}
					</span>
					<span
						class="diff-gutter diff-gutter-new min-w-[40px] px-2 text-right text-text-dimmer select-none shrink-0 text-sm"
					>
						{op.type !== "remove" ? (op.newLineNo ?? "") : ""}
					</span>
					<span class={markerClass(op.type)}>{markerChar(op.type)}</span>
					<span class={textClass(op.type)}>{@html escapeHtml(op.line || "")}</span>
				</div>
			{/each}
		</div>
	{:else}
		<!-- Split (side-by-side) view -->
		<div
			class={"diff-split-view overflow-x-auto bg-code-bg border border-border-subtle" + (filename ? " rounded-b-lg" : " rounded-lg")}
		>
			<table class="diff-table w-full font-mono text-xs leading-normal border-collapse">
				{#each splitRows as row, idx (row.type + "-" + idx)}
					<tr class={splitRowClass(row.type)}>
						<!-- Old side -->
						<td
							class="diff-ln text-right text-text-dimmer select-none px-2 text-sm w-[40px]"
						>
							{row.oldLineNo ?? ""}
						</td>
						<td
							class={"diff-marker text-center select-none font-semibold w-[20px]" + (row.type === "remove" || row.type === "change" ? " text-error" : "")}
						>
							{row.type === "remove" || row.type === "change" ? "-" : "\u00a0"}
						</td>
						<td
							class={"diff-code whitespace-pre pr-2 w-1/2 border-r border-border-subtle" + (row.type === "remove" || row.type === "change" ? " bg-error/[0.08] text-error" : " text-text-secondary")}
						>
							{#if row.oldLine !== null}
								{@html escapeHtml(row.oldLine)}
							{:else}
								&nbsp;
							{/if}
						</td>

						<!-- New side -->
						<td
							class="diff-ln text-right text-text-dimmer select-none px-2 text-sm w-[40px]"
						>
							{row.newLineNo ?? ""}
						</td>
						<td
							class={"diff-marker text-center select-none font-semibold w-[20px]" + (row.type === "add" || row.type === "change" ? " text-success" : "")}
						>
							{row.type === "add" || row.type === "change" ? "+" : "\u00a0"}
						</td>
						<td
							class={"diff-code whitespace-pre pr-2 w-1/2" + (row.type === "add" || row.type === "change" ? " bg-success/[0.08] text-success" : " text-text-secondary")}
						>
							{#if row.newLine !== null}
								{@html escapeHtml(row.newLine)}
							{:else}
								&nbsp;
							{/if}
						</td>
					</tr>
				{/each}
			</table>
		</div>
	{/if}
</div>
