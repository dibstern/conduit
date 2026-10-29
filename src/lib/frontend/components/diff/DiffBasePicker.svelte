<!-- What the branch diff compares against. The pick is the session's, so every client follows it. -->
<script module lang="ts">
	import type { SessionDiffBase } from "../../../contracts/session-diff.js";

	/** A launch base is a bare commit, so it reads as one. */
	export const baseLabel = ({ ref, source }: SessionDiffBase) => (source === "launch" ? `launch ${ref.slice(0, 7)}` : ref);
</script>

<script lang="ts">
	import { findSession } from "../../stores/session.svelte.js";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import { toastFailure } from "../../transport/rpc-errors.js";
	import { rpc } from "../../transport/ws-rpc-client.js";
	import Button from "../ui/Button.svelte";
	import Icon from "../ui/Icon.svelte";
	import Menu from "../ui/Menu.svelte";
	import MenuGroup from "../ui/MenuGroup.svelte";
	import MenuItem from "../ui/MenuItem.svelte";
	import MenuRadioGroup from "../ui/MenuRadioGroup.svelte";
	import MenuRadioItem from "../ui/MenuRadioItem.svelte";

	const { sessionId, base }: { sessionId: string; base: SessionDiffBase | undefined } = $props();

	const session = $derived(findSession(sessionId));
	const override = $derived(session?.diffBase ?? null);
	let branches = $state<readonly string[] | undefined>();

	async function openBranches() {
		branches = undefined;
		const projectSlug = session?.projectSlug;
		try {
			branches = projectSlug ? (await rpc("ListBranches", { projectSlug })).branches : [];
		} catch (error) {
			branches = [];
			toastFailure("Could not list branches")(error);
		}
	}
</script>

<div class="flex items-center border-b border-border-subtle px-2 py-1">
	<Menu ariaLabel="Diff base" presentation={sessionViewState.compact ? "sheet" : "popover"} onopenchange={(open) => { if (open) void openBranches(); }}>
		{#snippet trigger({ props })}
			<Button {...props} variant="ghost" size="content" tone="default" class="min-w-0 gap-1 px-1.5 py-1 text-xs" title="What this diff compares against" data-testid="session-diff-base">
				<Icon name="git-branch" size={12} />
				<span class="truncate">against {base ? baseLabel(base) : (override ?? "Automatic")}</span>
				<Icon name="chevron-down" size={12} />
			</Button>
		{/snippet}
		<MenuGroup label="Compare against">
			<!-- "" is no ref name, so it stands for the automatic base: launch, then default branch, then HEAD. -->
			<MenuRadioGroup value={override ?? ""} onvaluechange={(value) => void rpc("SetSessionDiffBase", { sessionId, base: value || null }).catch(toastFailure("Could not set the diff base"))}>
				<MenuRadioItem value="">Automatic</MenuRadioItem>
				{#if branches === undefined}
					<MenuItem disabled>Loading branches…</MenuItem>
				{:else}
					{#each new Set([...(override ? [override] : []), ...branches]) as name (name)}
						<MenuRadioItem value={name}>{name}</MenuRadioItem>
					{/each}
				{/if}
			</MenuRadioGroup>
		</MenuGroup>
	</Menu>
</div>
