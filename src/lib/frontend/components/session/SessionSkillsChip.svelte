<!--
	The session's skills: a sparkle and the distinct count, opening one row per
	skill in first-use order. Absent at zero, so a session that never loaded a
	skill spends no width on it.
-->
<script lang="ts">
	import { onDestroy, tick } from "svelte";
	import { reveal } from "../../stores/reveal.svelte.js";
	import { sessionState } from "../../stores/session.svelte.js";
	import {
		loadSessionSkills,
		sessionSkillRows,
		sessionSkillsState,
		type SessionSkillRow,
	} from "../../stores/session-skills.svelte.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import { formatTimeAgo } from "../../utils/format.js";
	import SkillDoc from "../chat/SkillDoc.svelte";
	import Badge from "../ui/Badge.svelte";
	import Button from "../ui/Button.svelte";
	import Menu from "../ui/Menu.svelte";
	import MenuGroup from "../ui/MenuGroup.svelte";
	import MenuItem from "../ui/MenuItem.svelte";
	import MenuSeparator from "../ui/MenuSeparator.svelte";

	let { presentation }: { presentation: "sheet" | "popover" } = $props();
	const menuId = $props.id();
	let open = $state(false);
	let detailName = $state<string | null>(null);
	let docShown = $state(false);
	let suppressPointerSelect = false;
	let hold: {
		pointerId: number;
		x: number;
		y: number;
		timer: ReturnType<typeof setTimeout>;
	} | null = null;

	$effect(() => {
		const sessionId = sessionState.currentId;
		if (sessionId) void loadSessionSkills(sessionId);
	});

	const rows = $derived(
		sessionSkillsState.sessionId === sessionState.currentId
			? sessionSkillRows(sessionSkillsState.loads)
			: [],
	);
	const loading = $derived(rows.some((row) => row.running));
	const label = $derived(`${rows.length} ${rows.length === 1 ? "skill" : "skills"} used`);
	const detail = $derived(rows.find((row) => row.name === detailName));
	// Stable sort after reversing puts the later array entry first on a tie.
	const runs = $derived(detail ? [...detail.loads].reverse().sort((a, b) => b.at - a.at) : []);
	$effect(() => {
		if (rows.length === 0) {
			open = false;
			resetMenu();
		}
	});

	function describe(row: SessionSkillRow): string {
		const who = row.byUser && row.byAgent ? "you + agent" : row.byUser ? "you" : "agent";
		const turns = `${row.turns.length === 1 ? "turn" : "turns"} ${row.turns.join(", ")}`;
		const when = row.running ? "loading now" : formatTimeAgo(row.lastAt, new Date(sessionState.now));
		return `${who} · ${turns} · ${when}`;
	}

	function suppressHoldSelect(event: Event): boolean {
		if (!suppressPointerSelect) return false;
		event.preventDefault();
		return true;
	}

	async function selectRun(event: Event, load: SessionSkillRow["loads"][number]): Promise<void> {
		if (suppressHoldSelect(event)) return;
		if ((await reveal(load.anchor)) === "missing")
			showToast("That skill run is no longer in this session");
	}

	function cancelHold() {
		if (hold) clearTimeout(hold.timer);
		hold = null;
	}
	onDestroy(cancelHold);

	function resetMenu() {
		cancelHold();
		detailName = null;
		docShown = false;
		suppressPointerSelect = false;
	}

	// Swapping views unmounts the focused item; bits' focus trap then resets
	// focus to the first item. Waiting a frame lets our choice land last.
	async function afterFocusTrap(): Promise<void> {
		await tick();
		await new Promise(requestAnimationFrame);
	}

	async function openRuns(name: string): Promise<void> {
		cancelHold();
		detailName = name;
		docShown = false;
		await afterFocusTrap();
		if (open && detailName === name)
			document.getElementById(`${menuId}-run-0`)?.focus({ preventScroll: true });
	}

	async function allSkills(): Promise<void> {
		const name = detailName;
		detailName = null;
		docShown = false;
		await afterFocusTrap();
		if (open && detailName === null)
			document.getElementById(`${menuId}-skill-${name}`)?.focus({ preventScroll: true });
	}

	function startHold(event: PointerEvent, name: string) {
		cancelHold();
		if (
			(event.pointerType !== "touch" && event.pointerType !== "pen") ||
			!event.isPrimary || event.button !== 0
		) return;
		hold = {
			pointerId: event.pointerId,
			x: event.clientX,
			y: event.clientY,
			timer: setTimeout(() => {
				// Keep swallowing the release's select, even after the row unmounts.
				// The next pointerdown or keydown starts a deliberate interaction.
				suppressPointerSelect = true;
				void openRuns(name);
			}, 500),
		};
	}

	function moveHold(event: PointerEvent) {
		if (
			hold?.pointerId === event.pointerId &&
			Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > 10
		)
			cancelHold();
	}

	function endHold(event: PointerEvent) {
		if (hold?.pointerId === event.pointerId) cancelHold();
	}

	function rowKeydown(event: KeyboardEvent, name: string) {
		if (
			event.key !== "ArrowRight" && event.key !== "ContextMenu" &&
			!(event.shiftKey && event.key === "F10")
		) return;
		event.preventDefault();
		event.stopPropagation();
		void openRuns(name);
	}

	function menuKeydown(event: KeyboardEvent) {
		suppressPointerSelect = false;
		if (detailName && event.key === "ArrowLeft") {
			event.preventDefault();
			event.stopPropagation();
			void allSkills();
		}
	}
</script>

<svelte:window onpointermovecapture={moveHold} onpointerupcapture={endHold} onpointercancelcapture={endHold} />

{#if rows.length > 0}
	<Menu
		{presentation}
		bind:open
		onopenchange={(nextOpen) => {
			if (!nextOpen) resetMenu();
		}}
		onpointerdowncapture={() => { suppressPointerSelect = false; }}
		onkeydowncapture={menuKeydown}
		align="end"
		ariaLabel="Skills used"
		data-testid="session-skills-menu"
	>
		{#snippet trigger({ props })}
			<!-- Sized like Views beside it; touchTarget gives the 44px phone hit area. -->
			<Button
				{...props}
				id="session-skills-chip"
				variant="secondary"
				size="sm"
				icon="sparkles"
				touchTarget
				class="shrink-0 tabular-nums"
				ariaLabel={label}
				title={label}
				data-testid="session-skills-chip"
			>
				{rows.length}
				{#if loading}
					<!-- Decorative: the open list says "loading now" in words. -->
					<span
						class="pointer-events-none absolute -top-0.5 -right-0.5 size-[7px] rounded-full bg-success ring-2 ring-bg motion-safe:animate-pulse"
						aria-hidden="true"
						data-testid="session-skills-chip-pulse"
					></span>
				{/if}
			</Button>
		{/snippet}
		{#if detail}
			<MenuItem icon="chevron-left" closeOnSelect={false} onselect={(event) => {
				if (!suppressHoldSelect(event)) void allSkills();
			}}>All skills</MenuItem>
			<MenuGroup label={detail.name} data-testid="session-skills-runs">
				{#each runs as load, index}
					<MenuItem id={`${menuId}-run-${index}`} data-testid="session-skills-run" data-turn={load.turnOrdinal} onselect={(event) => void selectRun(event, load)}>
						<span class="flex min-w-0 flex-1 flex-col">
							<span>Jump to turn {load.turnOrdinal}</span>
							<span class="text-xs text-text-muted" data-testid="session-skills-run-meta">{load.invokedBy === "user" ? "you" : "agent"} · {load.running ? "loading now" : formatTimeAgo(load.at, new Date(sessionState.now))}</span>
						</span>
					</MenuItem>
				{/each}
			</MenuGroup>
			<MenuSeparator />
			<MenuItem icon="file-text" closeOnSelect={false} onselect={(event) => {
				if (!suppressHoldSelect(event)) docShown = !docShown;
			}}>{docShown ? "Hide SKILL.md" : "Open SKILL.md"}</MenuItem>
			{#if docShown}
				<div class={presentation === "popover" ? "mx-2 mb-2 max-w-[28rem]" : "mx-4 mb-3"} data-testid="session-skills-doc">
					<SkillDoc name={detail.name} />
				</div>
			{/if}
		{:else}
			<MenuGroup label="Skills used">
				{#each rows as row (row.name)}
					{@const latest = row.loads.reduce((previous, load) => load.at >= previous.at ? load : previous)}
					<MenuItem
						id={`${menuId}-skill-${row.name}`}
						icon="sparkles"
						class="select-none [-webkit-touch-callout:none]"
						data-testid="session-skills-row"
						data-skill={row.name}
						onselect={(event) => void selectRun(event, latest)}
						oncontextmenu={(event: MouseEvent) => {
							event.preventDefault();
							suppressPointerSelect = true;
							void openRuns(row.name);
						}}
						onpointerdown={(event: PointerEvent) => startHold(event, row.name)}
						onkeydown={(event: KeyboardEvent) => rowKeydown(event, row.name)}
					>
						<span class="flex min-w-0 flex-1 flex-col">
							<span class="truncate font-medium text-text">{row.name}</span>
							<span class="truncate text-xs text-text-muted" data-testid="session-skills-row-meta">{describe(row)}</span>
						</span>
						{#if row.loads.length > 1}
							<Badge variant="quiet" size="xs" shape="pill" class="shrink-0 tabular-nums" data-testid="session-skills-row-count">×{row.loads.length}</Badge>
						{/if}
					</MenuItem>
				{/each}
			</MenuGroup>
			<div class="text-xs text-text-dimmer {presentation === 'sheet' ? 'px-4 pb-[5px] pt-[10px]' : 'px-3 py-1.5'}" data-testid="session-skills-hint">
				{presentation === "sheet" ? "Hold a skill for earlier runs and SKILL.md" : "Right-click a skill for earlier runs and SKILL.md"}
			</div>
		{/if}
	</Menu>
{/if}
