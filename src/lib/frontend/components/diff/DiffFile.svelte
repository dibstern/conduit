<!-- One file of a session diff: asks for its patch by size tier and renders it with @pierre/diffs. -->
<script module lang="ts">
	import { FileDiff, parsePatchFiles, type SelectedLineRange } from "@pierre/diffs";
	import { getOrCreateWorkerPoolSingleton } from "@pierre/diffs/worker";
	import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";

	const theme = { dark: "pierre-dark", light: "pierre-light" } as const;
	// Both themes are tokenised once, so a theme switch only swaps CSS.
	const workerPool = () =>
		getOrCreateWorkerPoolSingleton({
			poolOptions: { workerFactory: () => new DiffsWorker(), poolSize: 2 },
			highlighterOptions: { theme, tokenizeMaxLineLength: 1000 },
		});
</script>

<script lang="ts">
	import { untrack } from "svelte";
	import { REVIEW_EXCERPT_MAX_CHARS, REVIEW_TEXT_MAX_CHARS } from "../../../contracts/review-comment.js";
	import { getCurrentSessionId } from "../../stores/router.svelte.js";
	import type { DiffRow } from "../../stores/session-diff.svelte.js";
	import { openFileViewer } from "../../stores/session-view.svelte.js";
	import { themeState } from "../../stores/theme.svelte.js";
	import { failureLine } from "../../transport/rpc-errors.js";
	import { rpc } from "../../transport/ws-rpc-client.js";
	import { formatFileSize } from "../../utils/format.js";
	import { reviewExcerpt } from "../../utils/review-excerpt.js";
	import Button from "../ui/Button.svelte";
	import Textarea from "../ui/Textarea.svelte";
	import TextButton from "../ui/TextButton.svelte";

	const { row }: { row: DiffRow } = $props();
	const { folder, file } = $derived(row);
	const patch = $derived(row.patch.kind === "ready" ? row.patch.patch : null);

	let visible = $state(false);
	let clicked = $state(false);
	let host = $state<HTMLDivElement>();
	let view: FileDiff | undefined;
	// The lines picked for a review comment, and the comment being written.
	let selection = $state<SelectedLineRange | null>(null);
	let comment = $state("");
	let commentError = $state("");
	let saving = $state(false);
	const side = $derived(selection?.side ?? "additions");
	const endSide = $derived(selection?.endSide ?? side);
	// One side's numbers sort; numbers from the old and new file do not, so they keep selection order.
	const lines = $derived(
		selection &&
			(endSide === side
				? { start: Math.min(selection.start, selection.end), end: Math.max(selection.start, selection.end) }
				: { start: selection.start, end: selection.end }),
	);

	const wanted = $derived(
		file.tier === "tooLarge" || file.binary ? false : file.tier === "auto" ? visible : clicked,
	);

	$effect(() => {
		if (wanted && row.patch.kind === "idle") row.load();
	});

	$effect(() => {
		if (!host || patch === null) return;
		const [fileDiff] = parsePatchFiles(patch, `${folder}:${file.path}:${file.before}:${file.after}`).flatMap(
			(parsed) => parsed.files,
		);
		if (!fileDiff) return;
		const next = new FileDiff(
			{
				theme,
				themeType: untrack(() => themeState.resolved),
				diffStyle: "unified",
				overflow: "scroll",
				disableFileHeader: true,
				enableLineSelection: true,
				onLineSelectionEnd: (range) => {
					if (saving) return;
					selection = range;
					commentError = "";
				},
			},
			workerPool(),
		);
		next.render({ fileDiff, containerWrapper: host });
		view = next;
		return () => {
			view = undefined;
			next.cleanUp();
		};
	});

	$effect(() => {
		const type = themeState.resolved;
		view?.setThemeType(type);
	});

	function closeComment() {
		selection = null;
		comment = "";
		view?.setSelectedLines(null);
	}

	/** The server adds the comment to the session's draft, so every device's composer shows it. */
	async function addComment(event: SubmitEvent) {
		event.preventDefault();
		const sessionId = getCurrentSessionId();
		if (saving || !selection || !lines || !sessionId || patch === null || !comment.trim()) return;
		saving = true;
		try {
			await rpc("AddDraftReview", {
				key: { session: sessionId },
				id: crypto.randomUUID(),
				review: {
					folder,
					path: file.path,
					side,
					...(endSide !== side && { endSide }),
					lines,
					excerpt: reviewExcerpt(patch, selection).slice(0, REVIEW_EXCERPT_MAX_CHARS),
					text: comment.trim(),
				},
			});
			closeComment();
		} catch (error) {
			commentError = failureLine(error, "Could not add the comment. Try again.");
		} finally {
			saving = false;
		}
	}

	/** Small diffs load as they near the viewport. */
	function observe(node: HTMLElement) {
		if (file.tier !== "auto" || file.binary) return;
		const observer = new IntersectionObserver(
			([entry]) => {
				if (!entry?.isIntersecting) return;
				visible = true;
				observer.disconnect();
			},
			{ rootMargin: "200px 0px" },
		);
		observer.observe(node);
		return () => observer.disconnect();
	}
</script>

<section data-testid="session-diff-file" data-path={file.path} class="border-b border-border-subtle" {@attach observe}>
	<header class="flex items-center gap-2 px-3 py-1.5 text-xs">
		<span class="min-w-0 flex-1 truncate font-mono text-text-secondary" title={file.path}>
			{file.oldPath === undefined ? file.path : `${file.oldPath} → ${file.path}`}
		</span>
		{#if file.tier === "tooLarge"}
			<span class="shrink-0 text-text-dimmer">{formatFileSize(file.bytes)}</span>
		{:else if file.binary}
			<span class="shrink-0 text-text-dimmer">Binary</span>
		{:else}
			<span class="shrink-0 font-mono text-success">+{file.insertions}</span>
			<span class="shrink-0 font-mono text-error">−{file.deletions}</span>
		{/if}
	</header>
	{#if file.tier === "tooLarge"}
		<div class="flex items-center gap-2 px-3 pb-2 text-xs text-text-dimmer">
			<span>Too large to diff.</span>
			<TextButton underline="always" class="text-xs" onclick={() => openFileViewer(file.path, folder)}>Open in Files</TextButton>
		</div>
	{:else if file.tier === "onDemand" && !clicked}
		<div class="flex items-center gap-2 px-3 pb-2 text-xs text-text-dimmer">
			<span>{file.insertions + file.deletions} changed lines.</span>
			<TextButton underline="always" class="text-xs" onclick={() => (clicked = true)}>Load diff</TextButton>
		</div>
	{:else if row.patch.kind === "failed"}
		<p data-testid="session-diff-error" class="px-3 pb-2 text-xs text-error">{row.patch.message}</p>
	{:else if !file.binary}
		<!-- Unloaded rows reserve roughly their patch's height (changed lines plus
		     context, at pierre's 20px rows), so only nearby rows load and nothing jumps. -->
		<div bind:this={host} style:min-height={patch === null ? `${(file.insertions + file.deletions + 6) * 20}px` : undefined}></div>
		{#if lines}
			<form data-testid="review-comment-form" class="flex flex-col gap-2 px-3 py-2" onsubmit={addComment}>
				<Textarea bind:value={comment} disabled={saving} size="sm" rows={3} maxlength={REVIEW_TEXT_MAX_CHARS} aria-label="Review comment" placeholder={lines.start === lines.end ? `Comment on line ${lines.start}` : `Comment on lines ${lines.start}–${lines.end}`} />
				{#if commentError}<p role="alert" class="text-xs text-error">{commentError}</p>{/if}
				<div class="flex justify-end gap-2">
					<Button variant="ghost" size="sm" onclick={closeComment}>Cancel</Button>
					<Button variant="primary" size="sm" type="submit" disabled={saving || !comment.trim()}>Add to message</Button>
				</div>
			</form>
		{/if}
	{/if}
</section>

<style>
	/* Conduit's code-block surface in both themes, not pierre's #fff and #000.
	   Pierre sets --diffs-bg on its own host, so the override goes there too. */
	section :global(diffs-container) {
		--diffs-bg: var(--color-code-bg);
		--diffs-light-bg: var(--color-code-bg);
		--diffs-dark-bg: var(--color-code-bg);
		background-color: var(--color-code-bg);
	}
</style>
