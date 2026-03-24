<!-- ─── DashboardPage ────────────────────────────────────────────────────────── -->
<!-- Project dashboard page. Displays project cards in a list, each linking to -->
<!-- /p/{slug}/. Fetches from /api/projects on mount. Supports optional initial -->
<!-- data props for Storybook. -->

<!-- svelte-ignore state_referenced_locally -->
<script lang="ts">
	import { onMount } from "svelte";
	import { navigate } from "../stores/router.svelte.js";
	import type { DashboardProject } from "./dashboard-types.js";
	import ProjectContextMenu from "../components/project/ProjectContextMenu.svelte";
	import Icon from "../components/shared/Icon.svelte";
	import { confirm } from "../stores/ui.svelte.js";

	export type { DashboardProject };

	// ─── Props ──────────────────────────────────────────────────────────────────

	let {
		initialProjects,
		initialVersion = "",
		initialLoading,
	}: {
		/** Pre-loaded projects (bypasses fetch; for Storybook). */
		initialProjects?: DashboardProject[];
		/** Pre-loaded version string (for Storybook). */
		initialVersion?: string;
		/** Override loading state (for Storybook). */
		initialLoading?: boolean;
	} = $props();

	// ─── State ──────────────────────────────────────────────────────────────────
	// Props are used as seed values only; the component owns the mutable state.

	let projects: DashboardProject[] = $state(initialProjects ?? []);
	let loading = $state(initialLoading ?? !initialProjects);
	let version = $state(initialVersion);

	// ─── Derived ────────────────────────────────────────────────────────────────

	const isEmpty = $derived(!loading && projects.length === 0);

	// ─── Scroll state ─────────────────────────────────────────────────────────
	let scrollEl: HTMLElement | undefined = $state();
	let showBottomFade = $state(false);

	function handleScroll() {
		if (!scrollEl) return;
		const { scrollTop, scrollHeight, clientHeight } = scrollEl;
		showBottomFade = scrollHeight - scrollTop - clientHeight > 10;
	}

	// Recompute fade when projects change or component mounts
	$effect(() => {
		// Track projects.length to re-run when list changes
		void projects.length;
		// Use requestAnimationFrame to ensure DOM has updated
		requestAnimationFrame(() => handleScroll());
	});

	// ─── Context menu state ───────────────────────────────────────────────────
	let ctxMenuProject: DashboardProject | null = $state(null);
	let ctxMenuAnchor: HTMLElement | null = $state(null);

	function handleProjectContextMenu(
		project: DashboardProject,
		anchor: HTMLElement,
	) {
		ctxMenuProject = project;
		ctxMenuAnchor = anchor;
	}

	function handleCloseContextMenu() {
		ctxMenuProject = null;
		ctxMenuAnchor = null;
	}

	async function handleCtxDelete(slug: string, title: string) {
		const confirmed = await confirm(
			`Remove project '${title}' from conduit?`,
			"Remove",
		);
		if (!confirmed) return;
		try {
			const res = await fetch(
				`/api/projects/${encodeURIComponent(slug)}`,
				{ method: "DELETE" },
			);
			if (res.ok) {
				await fetchProjects();
			} else {
				// Optimistic removal failed — project will reappear on next poll
				projects = projects.filter((p) => p.slug !== slug);
			}
		} catch {
			// Network error — project list will refresh on next poll
		}
	}

	// ─── Fetch projects on mount ────────────────────────────────────────────────

	onMount(() => {
		// Standalone PWA check: redirect to setup if not done
		const isStandalone =
			window.matchMedia("(display-mode:standalone)").matches ||
			navigator.standalone;
		if (isStandalone && !localStorage.getItem("setup-done")) {
			const isTailscale = /^100\./.test(location.hostname);
			navigate(`/setup${isTailscale ? "" : "?mode=lan"}`);
			return;
		}

		// Skip fetch if initial data was provided (Storybook)
		if (initialProjects) return;

		fetchProjects();
	});

	// ─── Poll for project updates while visible ────────────────────────────────

	const POLL_INTERVAL_MS = 5_000;

	$effect(() => {
		// Skip polling when initial data was provided (Storybook)
		if (initialProjects) return;

		let timer: ReturnType<typeof setInterval> | undefined;

		function startPolling() {
			if (timer != null) return;
			timer = setInterval(() => fetchProjects(), POLL_INTERVAL_MS);
		}

		function stopPolling() {
			if (timer != null) {
				clearInterval(timer);
				timer = undefined;
			}
		}

		function onVisibilityChange() {
			if (document.visibilityState === "visible") {
				fetchProjects();
				startPolling();
			} else {
				stopPolling();
			}
		}

		// Start polling only when the page is visible
		if (document.visibilityState === "visible") {
			startPolling();
		}
		document.addEventListener("visibilitychange", onVisibilityChange);

		return () => {
			stopPolling();
			document.removeEventListener("visibilitychange", onVisibilityChange);
		};
	});

	async function fetchProjects() {
		try {
			const ac = new AbortController();
			const timer = setTimeout(() => ac.abort(), 8_000);
			const res = await fetch("/api/projects", { signal: ac.signal });
			clearTimeout(timer);

			// Auth required — redirect to PIN page
			if (res.status === 401) {
				navigate("/auth");
				return;
			}

			const data = await res.json();
			projects = data.projects ?? [];
			version = data.version ?? "";
		} catch {
			// Failed to load or timed out — leave empty
		} finally {
			loading = false;
		}
	}

	// ─── Helpers ────────────────────────────────────────────────────────────────

	function statusIcon(project: DashboardProject): string {
		if (project.status === "registering") return "\u23F3"; // ⏳
		if (project.status === "error") return "\u274C"; // ❌
		if (project.isProcessing) return "\u26A1"; // ⚡
		if (project.clients > 0) return "\uD83D\uDFE2"; // 🟢
		return "\u23F8"; // ⏸
	}

	function displayName(project: DashboardProject): string {
		return project.title || project.slug;
	}

	function sessionLabel(count: number): string {
		return count === 1 ? "1 session" : `${count} sessions`;
	}

	function clientLabel(count: number): string {
		return count === 1 ? "1 client" : `${count} clients`;
	}

	function handleCardClick(e: MouseEvent, slug: string) {
		e.preventDefault();
		navigate(`/p/${slug}/`);
	}
</script>

<div
	class="bg-bg h-screen flex flex-col items-center pt-10 text-text font-sans"
>
	<!-- Pinned header -->
	<h1 class="text-2xl font-semibold mb-2 shrink-0">Conduit</h1>
	<div class="text-base text-text-muted mb-6 shrink-0">Select a project</div>

	<!-- Scrollable project list area -->
	<div class="relative flex-1 min-h-0 w-full max-w-[480px] px-5" data-testid="project-list-scroll-area">
		<div
			bind:this={scrollEl}
			onscroll={handleScroll}
			class="h-full overflow-y-auto flex flex-col gap-3 pb-4"
			data-testid="project-list"
		>
			{#if loading}
				<div class="text-center text-text-dimmer text-sm py-10">Loading...</div>
			{:else if isEmpty}
				<div class="text-center text-text-dimmer text-sm py-10 px-5">
					No projects registered. Run
					<code
						class="bg-bg-alt px-1.5 py-0.5 rounded text-base text-text"
						>conduit</code
					> in a project directory to add one.
				</div>
			{:else}
				{#each projects as project (project.slug)}
					<a
						href="/p/{project.slug}/"
						data-testid="project-card"
						data-slug={project.slug}
						class="group block shrink-0 bg-bg-alt border border-border rounded-xl p-[16px_20px] no-underline text-text transition-[border-color,background] hover:border-accent hover:bg-bg-surface"
						onclick={(e) => handleCardClick(e, project.slug)}
					>
						<div
							class="text-lg font-semibold flex items-center gap-2"
						>
							{displayName(project)}
							<span class="text-sm">{statusIcon(project)}</span>
							<button
								class="dash-more-btn shrink-0 ml-auto w-6 h-6 border-none rounded p-0 bg-transparent cursor-pointer flex items-center justify-center text-text-dimmer opacity-0 group-hover:opacity-100 hover:text-text hover:bg-bg-surface transition-[opacity,color] duration-100"
								title="More options"
								onclick={(e) => {
									e.preventDefault();
									e.stopPropagation();
									handleProjectContextMenu(project, e.currentTarget as HTMLElement);
								}}
							>
								<Icon name="ellipsis" size={15} />
							</button>
						</div>
					<div
						class="text-xs text-text-muted mt-1 font-mono overflow-hidden text-ellipsis whitespace-nowrap"
					>
						{project.path}
					</div>
					{#if project.status === "error" && project.error}
						<span class="block text-xs text-red-400 truncate mt-0.5" title={project.error}>
							{project.error}
						</span>
					{/if}
						<div class="text-xs text-text-dimmer mt-2">
							{sessionLabel(project.sessions)} &middot; {clientLabel(project.clients)}
						</div>
					</a>
				{/each}
			{/if}
		</div>

		<!-- Bottom fade gradient (visible when more content below) -->
		{#if showBottomFade}
			<div
				class="pointer-events-none absolute bottom-0 left-0 right-0 h-12"
				style="background: linear-gradient(to top, var(--color-bg), transparent)"
				data-testid="scroll-fade"
			></div>
		{/if}
	</div>

	<!-- Pinned footer -->
	{#if version}
		<div class="shrink-0 py-4 text-sm text-text-dimmer">v{version}</div>
	{/if}
</div>

{#if ctxMenuProject && ctxMenuAnchor}
	<ProjectContextMenu
		project={{ slug: ctxMenuProject.slug, title: ctxMenuProject.title, directory: ctxMenuProject.path }}
		anchor={ctxMenuAnchor}
		ondelete={handleCtxDelete}
		onclose={handleCloseContextMenu}
	/>
{/if}
