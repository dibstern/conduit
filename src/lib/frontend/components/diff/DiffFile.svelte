<!-- One file of a session diff: asks for its patch by size tier and renders it with @pierre/diffs. -->
<script module lang="ts">
	import { FileDiff, parsePatchFiles } from "@pierre/diffs";
	import { getOrCreateWorkerPoolSingleton } from "@pierre/diffs/worker";
	import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";

	const theme = { dark: "pierre-dark", light: "pierre-light" } as const;
	// Both themes are tokenised once, so a theme switch only swaps CSS.
	const workerPool = () =>
		getOrCreateWorkerPoolSingleton({
			poolOptions: { workerFactory: () => new DiffsWorker(), poolSize: 2 },
			highlighterOptions: { theme, tokenizeMaxLineLength: 1000 },
		});
	const kindLabel = { lfs: "Git LFS", submodule: "Submodule", symlink: "Symlink" } as const;
	const noteLabel = { crlf: "CRLF", latin1: "Not UTF-8 (Latin-1)" } as const;
</script>

<script lang="ts">
	import { untrack } from "svelte";
	import type { DiffRow } from "../../stores/session-diff.svelte.js";
	import { openFileViewer } from "../../stores/session-view.svelte.js";
	import { themeState } from "../../stores/theme.svelte.js";
	import { formatFileSize } from "../../utils/format.js";
	import TextButton from "../ui/TextButton.svelte";

	// `reveal` changes each time this file is asked for, from a link, Back or a click.
	const { row, reveal }: { row: DiffRow; reveal?: string | null | undefined } = $props();
	const { folder, file } = $derived(row);
	const patch = $derived(row.patch.kind === "ready" ? row.patch.patch : null);
	const labels = $derived([
		...(file.kind ? [kindLabel[file.kind]] : []),
		...(file.mode ? [`${file.mode.before} → ${file.mode.after}`] : []),
		...(row.patch.kind === "ready" ? (row.patch.notes ?? []).map((note) => noteLabel[note]) : []),
	]);
	// Git's patch for these is a hash, a commit pair or only a header, so the row says what changed instead.
	const patchless = $derived(
		file.tier === "tooLarge" ||
			file.binary ||
			file.kind === "lfs" ||
			file.kind === "submodule" ||
			file.before === file.after,
	);

	let visible = $state(false);
	let clicked = $state(false);
	let host = $state<HTMLDivElement>();
	let section = $state<HTMLElement>();
	let view: FileDiff | undefined;

	const wanted = $derived(
		patchless ? false : file.tier === "auto" ? visible : clicked,
	);

	$effect(() => {
		if (wanted && row.patch.kind === "idle") row.load();
	});

	// A reveal scrolls here and counts as the click a long diff waits for.
	$effect(() => {
		if (reveal === undefined || !section) return;
		clicked = true;
		return holdAtTop(section);
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

	/**
	 * Keeps a revealed row at the top of the pane while the rows around it load
	 * and resize, until the pane is scrolled from there. Only the pane scrolls,
	 * never the page around it. Rows sit inside folder groups, so the pane is
	 * found, not assumed to be the row's parent; its children are those groups.
	 */
	function holdAtTop(node: HTMLElement) {
		const pane = node.closest<HTMLElement>('[data-testid="session-diff"]');
		if (!pane) return;
		let held = pane.scrollTop;
		const sizes = new ResizeObserver(() => {
			pane.scrollTop += node.getBoundingClientRect().top - pane.getBoundingClientRect().top;
			held = pane.scrollTop;
		});
		for (const child of pane.children) sizes.observe(child);
		const release = () => {
			if (Math.abs(pane.scrollTop - held) > 1) stop();
		};
		const stop = () => {
			sizes.disconnect();
			pane.removeEventListener("scroll", release);
		};
		pane.addEventListener("scroll", release, { passive: true });
		return stop;
	}

	/** Small diffs load as they near the viewport. */
	function observe(node: HTMLElement) {
		if (file.tier !== "auto" || patchless) return;
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

<section bind:this={section} data-testid="session-diff-file" data-path={file.path} data-folder={folder} class="border-b border-border-subtle" {@attach observe}>
	<header class="flex items-center gap-2 px-3 py-1.5 text-xs">
		<span class="min-w-0 flex-1 truncate font-mono text-text-secondary" title={file.path}>
			{file.oldPath === undefined ? file.path : `${file.oldPath} → ${file.path}`}
		</span>
		{#each labels as label (label)}
			<span data-testid="session-diff-label" class="shrink-0 text-text-dimmer">{label}</span>
		{/each}
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
	{:else if file.kind === "submodule"}
		<p class="px-3 pb-2 font-mono text-xs text-text-dimmer">
			Commit {[file.before, file.after].flatMap((id) => (id ? [id.slice(0, 7)] : [])).join(" → ")}
		</p>
	{:else if file.kind === "lfs"}
		<p class="px-3 pb-2 text-xs text-text-dimmer">Stored in Git LFS.</p>
	{:else if file.before === file.after}
		<p class="px-3 pb-2 text-xs text-text-dimmer">No content changes.</p>
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
