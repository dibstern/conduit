<!-- Renders a side-by-side or unified diff between two text inputs.            -->
<!-- Computes diff ops using the LCS-based diff utility and renders with        -->
<!-- proper line numbers, markers, and color-coded styling.                     -->

<script lang="ts">
	import { computeDiff, buildSplitRows, diffStats } from "../../utils/diff.js";
	import { escapeHtml } from "../../utils/format.js";
	import type { DiffOp, SplitRow } from "../../types.js";
	import Tabs from "../ui/Tabs.svelte";
	import CodeBlockHeader from "../ui/CodeBlockHeader.svelte";

	let {
		oldText,
		newText,
		filename,
	}: {
		oldText: string;
		newText: string;
		filename?: string;
	} = $props();

	let viewMode = $state<"unified" | "split">("unified");

	const ops = $derived(computeDiff(oldText.split("\n"), newText.split("\n")));

	const splitRows = $derived(buildSplitRows(ops));

	const stats = $derived(diffStats(oldText, newText));

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

<div class="diff-container min-w-0 overflow-hidden rounded-[12px] border border-border-subtle bg-code-bg">
	<div class="diff-filename diff-stats">
		<CodeBlockHeader {filename} label="diff" additions={stats.additions} deletions={stats.deletions} code={newText}>
			{#snippet controls()}
				<Tabs
					bind:value={viewMode}
					variant="pill"
					label="Diff view mode"
					options={[
						{ value: "unified", label: "Unified" },
						{ value: "split", label: "Split" },
					]}
				/>
			{/snippet}
		</CodeBlockHeader>
	</div>

	<!-- Unified view -->
	{#if viewMode === "unified"}
		<div
			class="diff-viewer font-mono text-mono-code leading-[20px] overflow-x-auto py-[8px]"
		>
			{#each ops as op (op.type + "-" + (op.oldLineNo ?? "") + "-" + (op.newLineNo ?? ""))}
				<div class={lineClass(op.type)}>
					<span
						class="diff-gutter diff-gutter-old min-w-[36px] px-[8px] text-right text-text-dimmer select-none shrink-0 text-mono-time border-r border-border-subtle"
					>
						{op.type !== "add" ? (op.oldLineNo ?? "") : ""}
					</span>
					<span
						class="diff-gutter diff-gutter-new min-w-[36px] px-[8px] text-right text-text-dimmer select-none shrink-0 text-mono-time"
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
			class="diff-split-view overflow-x-auto py-[8px]"
		>
		<table class="diff-table w-full font-mono text-mono-code leading-[20px] border-collapse">
			<tbody>
			{#each splitRows as row, idx (row.type + "-" + idx)}
				<tr class={splitRowClass(row.type)}>
						<!-- Old side -->
						<td
							class="diff-ln text-right text-text-dimmer select-none px-[8px] text-mono-time w-[36px]"
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
							class="diff-ln text-right text-text-dimmer select-none px-[8px] text-mono-time w-[36px]"
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
			</tbody>
		</table>
		</div>
	{/if}
</div>
