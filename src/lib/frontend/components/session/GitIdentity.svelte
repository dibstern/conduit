<script lang="ts">
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import { composerPickerState, openPicker } from "../../stores/composer-picker.svelte.js";
	import { getWorkspaceCheckout } from "../../stores/workspace-checkout.svelte.js";
	import Button from "../ui/Button.svelte";
	import Field from "../ui/Field.svelte";
	import Icon from "../ui/Icon.svelte";
	import Modal from "../ui/Modal.svelte";
	import TextInput from "../ui/TextInput.svelte";

	let { presentation, compact = false }: {
		presentation: "word" | "control";
		compact?: boolean | undefined;
	} = $props();
	const checkoutState = $derived(getWorkspaceCheckout());
	const git = $derived(checkoutState.git);
	const control = $derived(presentation === "control");
	const phone = $derived(sessionViewState.composerTier === "phone");
	let identityElement = $state<HTMLButtonElement | HTMLAnchorElement>();
	const componentId = $props.id();
	const branchRenameFormId = `${componentId}-branch-rename`;
	const showBranchRename = $derived(checkoutState.showBranchRename);
	const project = $derived(checkoutState.projectName);
	const checkout = $derived(phone && compact ? undefined : checkoutState.checkoutName);
	const label = $derived(checkoutState.label);
	const operation = $derived(checkoutState.operationLabel);
	// Phones show one status word: an in-progress operation outranks merged.
	const showMerged = $derived(git?.merged === true && !(phone && operation));
	const upstreamMark = $derived([git?.ahead ? `↑${git.ahead}` : "", git?.behind ? `↓${git.behind}` : ""].filter(Boolean).join(" "));
	const noticeLabels = $derived((phone ? checkoutState.rowNotices : checkoutState.notices).map((notice) => notice.label));
	const noticeLabel = $derived(noticeLabels.join(", "));
	const projectFloor = $derived(Math.min(project.length, 4.5));
	const branchFloor = $derived(Math.min(checkout?.length ?? 0, 6.5));
	// Checkout gives up its labels before the model label needs to truncate.
	type Fit = "full" | "icon";
	// Floor = labels + slash and fixed marks in ch, plus icon, gaps, padding, chevron and notices in px. It wins over the nominal cap for long operation labels.
	function floor(fit: Fit) {
		const marks = fit === "icon" ? [] : [
			!phone && upstreamMark ? upstreamMark.length : null,
			operation ? operation.length : null,
			showMerged ? 6 : null,
		].filter((width) => width !== null);
		const labels = fit === "icon" ? [] : !control && checkout ? [branchFloor] : checkout ? [projectFloor, 1, branchFloor] : [projectFloor];
		const widths = [...labels, ...marks];
		return { ch: widths.reduce((sum, width) => sum + width, 0), px: 12 + 5 * widths.length + (control ? 12 : 0) + (fit === "icon" ? 0 : (noticeLabels.length ? 17 : 0) + (git?.dirty ? 11 : 0)) };
	}
	// Unmeasured until bound: a measured 0 means send left no room, which must fall to icon.
	let room = $state<number>();
	let hundredCh = $state(0);
	const fit = $derived.by((): Fit => {
		const available = room;
		if (compact) return available === undefined || available >= 66 ? "full" : "icon";
		if (available === undefined || !hundredCh) return "full";
		const fits = (candidate: Fit) => {
			const { ch, px } = floor(candidate);
			return (ch * hundredCh) / 100 + px <= available;
		};
		return fits("full") && (!control || available >= 220) ? "full" : "icon";
	});
	const width = (candidate: Fit) => {
		const { ch, px } = floor(candidate);
		return `calc(${ch}ch + ${px}px)`;
	};
	const minimumWidth = $derived(compact ? control ? "44px" : "66px" : width(fit));

</script>

{#snippet dirtyMark(placement: string)}
	<span data-part="dirty" class="{placement} size-[6px] rounded-full bg-warning" title="Uncommitted changes"><span class="sr-only">Uncommitted changes</span></span>
{/snippet}

{#snippet identity()}
			<span class="relative flex size-[12px] shrink-0 items-center {presentation === 'word' ? 'text-text-dimmer' : 'text-text-muted'}" data-part={git?.worktree ? "worktree" : undefined} data-icon={(phone && compact) || !git ? "folder" : !git.branch ? "commit" : git.worktree ? "worktree" : "branch"}>
				{#if git && !git.branch && !(phone && compact)}
					<!-- Compose the commit glyph from the existing circle icon. -->
					<span class="commit-icon"><Icon name="circle" size={4} /></span>
				{:else}
					<Icon name={(phone && compact) || !git ? "folder" : git.worktree ? "folder-tree" : "git-branch"} size={12} />
				{/if}
				<!-- Without labels the dirty mark rides the icon; with them it follows the branch. -->
				{#if git?.dirty && fit === "icon"}{@render dirtyMark("absolute -right-[2px] -bottom-[1px] ring-[1.5px] ring-input-bg")}{/if}
			</span>
			{#if fit === "full" && ((!compact && control) || !checkout)}
				<span data-part="project" class="shrink-[100000000] truncate text-text-muted" style={`min-width: ${compact ? '0' : `calc(${projectFloor}ch + 1px)`}`} title={project}>{project}</span>
				{#if checkout}<span class="shrink-0 text-text-dimmer" aria-hidden="true">{control ? "·" : "/"}</span>{/if}
			{/if}
			{#if fit !== "icon"}
				{#if checkout}
					<span data-part="branch" class="min-w-0 truncate {presentation === 'word' ? 'text-text-dimmer' : git?.branch ? 'text-text-secondary' : 'text-text-muted'}" style:min-width={compact ? '0' : `${branchFloor}ch`} title={git?.branch ? `Branch: ${checkout}` : `Detached at ${checkout}`}>{checkout}</span>
				{/if}
				{#if git?.dirty}{@render dirtyMark("shrink-0")}{/if}
				{#if !phone && upstreamMark}
					<span data-part="upstream" class="shrink-0 tabular-nums text-text-muted">{upstreamMark}</span>
				{/if}
				{#if !compact && operation}<span data-part="operation" class="shrink-0 text-warning">{operation}</span>{/if}
				{#if !compact && showMerged}<span data-part="merged" class="shrink-0 text-success">merged</span>{/if}
			{/if}
			{#if noticeLabel}
				<span data-part="warning" class="text-warning {fit === 'icon' ? 'absolute right-[2px] top-[2px]' : 'inline-flex shrink-0'}" role="img" aria-label={noticeLabel} title={noticeLabel} data-testid="workspace-notice-indicator"><Icon name="circle-alert" size={12} /></span>
			{/if}
{/snippet}

<!-- A grid track gives the pill an honest minimum: flex parents read a truncating label's minimum as its full text width, so the bar would overflow instead of shrinking the title. -->
<!-- The wrapper, ruler and button share a font so the ch floors agree. -->
<span class="git-pill {control ? 'git-control font-mono' : 'git-word font-sans'} text-[11.5px] inline-grid" class:compact style={`grid-template-columns: minmax(${minimumWidth}, max-content)`} style:width={!control && fit === "icon" ? width("full") : undefined} bind:clientWidth={room}><span class="ruler" aria-hidden="true" bind:clientWidth={hundredCh}></span><Button bind:element={identityElement} variant={control ? "composer-checkout" : "composer-word"} size={control ? "composer-chip" : "content"} touchTarget align="start" class="max-w-full"
	style={`min-width: ${minimumWidth}`}
	title={label} ariaLabel={`Checkout: ${[label, ...noticeLabels].join(", ")}`} data-testid="composer-checkout"
	aria-haspopup="dialog"
	aria-expanded={composerPickerState.request?.section === "checkout"}
	aria-controls={composerPickerState.request?.section === "checkout" ? "model-picker" : undefined}
	onclick={(event) => {
		openPicker("checkout");
		if (composerPickerState.request && event.currentTarget instanceof HTMLElement) composerPickerState.request.opener = event.currentTarget;
	}}>
	{@render identity()}
</Button></span>

<Modal open={showBranchRename} title="Rename branch" description="Rename the branch in every worktree created for this session." size="sm" placement={phone ? "sheet" : "center"} dismissible={!checkoutState.renamingBranch} showClose={!checkoutState.renamingBranch} onclose={() => { if (!checkoutState.renamingBranch) checkoutState.showBranchRename = false; }} returnFocus={() => identityElement ?? null}>
	<form id={branchRenameFormId} onsubmit={(event) => { event.preventDefault(); void checkoutState.renameBranch(); }} aria-busy={checkoutState.renamingBranch}>
		<Field label="Branch name" error={checkoutState.branchRenameError}>
			<TextInput bind:value={checkoutState.branchName} readonly={checkoutState.renamingBranch} autofocus={showBranchRename} autocomplete="off" autocapitalize="off" spellcheck={false} data-testid="session-branch-rename-input" oninput={() => { checkoutState.branchRenameError = undefined; }} />
		</Field>
	</form>
	{#snippet footer()}
		<Button variant="secondary" size="sm" disabled={checkoutState.renamingBranch} onclick={() => { checkoutState.showBranchRename = false; }} data-testid="session-branch-rename-cancel">Cancel</Button>
		<Button variant="primary" size="sm" type="submit" form={branchRenameFormId} disabled={checkoutState.renamingBranch || !checkoutState.branchName.trim()} data-testid="session-branch-rename-submit">{checkoutState.renamingBranch ? "Renaming…" : "Rename"}</Button>
	{/snippet}
</Modal>

<style>
	/* The cap sits on the grid wrapper, the flex item: on the button it left the wrapper sized to the full label, with dead space after the pill. */
	.git-pill { max-width: 100%; flex-shrink: 1; }
	/* A stable slot measures available room in block, grid and flex parents. Checkout still yields before the model. */
	.git-pill.git-control { position: relative; width: 100%; flex: 0 1000000 220px; min-width: 30px; max-width: 220px; justify-content: end; }
	/* Phone models yield their name first; checkout keeps a readable project until then. */
	.git-pill.git-control.compact { flex: 0 0 var(--composer-checkout-width, 90px); max-width: 110px; }
	/* Content-sized, so it sits beside the context %. As an icon it still asks for its full width, or it could never grow back. */
	.git-pill.git-word { position: relative; flex: 0 1 auto; min-width: 12px; justify-content: end; }
	/* 100ch in the pill's font turns ch floors into px. It extends left from the pill, so it never adds scroll. */
	.ruler { position: absolute; top: 0; right: 0; width: 100ch; height: 0; visibility: hidden; pointer-events: none; }
	.commit-icon { display: flex; align-items: center; width: 12px; }
	.commit-icon::before, .commit-icon::after { content: ""; flex: 1; border-top: 1px solid currentColor; }
</style>
