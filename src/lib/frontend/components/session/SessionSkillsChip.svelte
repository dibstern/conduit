<!--
	The session's skills: a sparkle and the distinct count, opening one row per
	skill in first-use order. Absent at zero, so a session that never loaded a
	skill spends no width on it.
-->
<script lang="ts">
	import { sessionState } from "../../stores/session.svelte.js";
	import {
		loadSessionSkills,
		sessionSkillRows,
		sessionSkillsState,
		type SessionSkillRow,
	} from "../../stores/session-skills.svelte.js";
	import { formatTimeAgo } from "../../utils/format.js";
	import Badge from "../ui/Badge.svelte";
	import Button from "../ui/Button.svelte";
	import Menu from "../ui/Menu.svelte";
	import MenuGroup from "../ui/MenuGroup.svelte";
	import MenuItem from "../ui/MenuItem.svelte";

	let { presentation }: { presentation: "sheet" | "popover" } = $props();

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

	function describe(row: SessionSkillRow): string {
		const who = row.byUser && row.byAgent ? "you + agent" : row.byUser ? "you" : "agent";
		const turns = `${row.turns.length === 1 ? "turn" : "turns"} ${row.turns.join(", ")}`;
		const when = row.running ? "loading now" : formatTimeAgo(row.lastAt, new Date(sessionState.now));
		return `${who} · ${turns} · ${when}`;
	}
</script>

{#if rows.length > 0}
	<Menu {presentation} align="end" ariaLabel="Skills used" data-testid="session-skills-menu">
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
		<MenuGroup label="Skills used">
			{#each rows as row (row.name)}
				<MenuItem icon="sparkles" data-testid="session-skills-row" data-skill={row.name}>
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
	</Menu>
{/if}
