<!-- One file of a session diff: fetches its patch by size tier and renders it with @pierre/diffs. -->
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
</script>

<script lang="ts">
	import { untrack } from "svelte";
	import {
		SessionDiffError,
		type SessionDiffFile,
		type SessionDiffScope,
	} from "../../../contracts/session-diff.js";
	import { openFileViewer } from "../../stores/session-view.svelte.js";
	import { themeState } from "../../stores/theme.svelte.js";
	import { failureLine } from "../../transport/rpc-errors.js";
	import { rpc } from "../../transport/ws-rpc-client.js";
	import { formatFileSize } from "../../utils/format.js";
	import TextButton from "../ui/TextButton.svelte";

	let {
		sessionId,
		scope,
		revision,
		listed,
		folder,
		file,
		onGone,
	}: {
		sessionId: string;
		scope: SessionDiffScope;
		revision: string;
		/** Counts landed listings: an unchanged folder re-lists the same revision. */
		listed: number;
		folder: string;
		file: SessionDiffFile;
		/** The listing's snapshot was collected; the owner re-lists. */
		onGone: () => void;
	} = $props();

	let visible = $state(false);
	let clicked = $state(false);
	let loading = $state(false);
	let patch = $state<string | null>(null);
	let failure = $state<string | null>(null);
	let host = $state<HTMLDivElement>();
	// The listing that answered Gone; the next one to land retries.
	let goneAt: number | null = null;
	let view: FileDiff | undefined;

	const wanted = $derived(
		file.tier === "tooLarge" || file.binary ? false : file.tier === "auto" ? visible : clicked,
	);

	$effect(() => {
		if (!wanted || loading || patch !== null || failure !== null || listed === goneAt) return;
		void load(revision, listed);
	});

	async function load(at: string, landed: number) {
		loading = true;
		try {
			const reply = await rpc("SessionDiffFile", {
				sessionId,
				scope,
				revision: at,
				folder,
				path: file.path,
				before: file.before,
				after: file.after,
			});
			patch = reply.patch;
		} catch (error) {
			if (error instanceof SessionDiffError && error.reason === "gone") {
				goneAt = landed;
				onGone();
			} else failure = failureLine(error, "Could not load this diff.");
		} finally {
			loading = false;
		}
	}

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
	{:else if failure !== null}
		<p data-testid="session-diff-error" class="px-3 pb-2 text-xs text-error">{failure}</p>
	{:else if !file.binary}
		<!-- Unloaded rows reserve roughly their patch's height (changed lines plus
		     context, at pierre's 20px rows), so only nearby rows load and nothing jumps. -->
		<div bind:this={host} style:min-height={patch === null ? `${(file.insertions + file.deletions + 6) * 20}px` : undefined}></div>
	{/if}
</section>
