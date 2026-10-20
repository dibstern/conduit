<script lang="ts">
	import type { AskExplanation } from "../../../contracts/ask-explanation.js";
	import { splitCitations } from "../../utils/citations.js";
	import { surfaceTime, type SurfacePart, type SurfaceTurn } from "../../utils/surface-turn.js";
	import Button from "../ui/Button.svelte";

	let { setup, view, start, explanation, generating = false, error = "", enabled = true, onexplain, oncite, onReplyToAsk }: {
		setup: SurfacePart | null;
		view: SurfaceTurn;
		start: number;
		explanation?: AskExplanation | undefined;
		generating?: boolean;
		error?: string;
		enabled?: boolean;
		onexplain: () => void;
		oncite: (part: SurfacePart) => void;
		onReplyToAsk: (text?: string) => void;
	} = $props();
	let followed = $state<number[]>([]);
	function follow(part: SurfacePart) {
		if (part.surfacingOrdinal !== undefined) followed = [...followed, part.surfacingOrdinal];
		oncite(part);
	}
</script>

{#snippet prose(text: string)}
	{#each splitCitations(text, view.numbers) as chunk}
		{#if chunk.message}
			{@const message = chunk.message}
			<Button variant="ghost" size="content" tone="inherit" hoverFill="none" touchTarget class="ask-cite" data-testid="ask-cite-{message.number}" data-unread={message.part.surfacingRead === false} data-followed={followed.includes(message.number)} data-ask={view.openAsk?.uuid === message.part.uuid} ariaLabel={`Go to message #${message.number}`} onclick={() => follow(message.part)}>#{message.number}</Button>
		{:else if chunk.code}<code>{chunk.text}</code>{:else}{chunk.text}{/if}
	{/each}
{/snippet}

<div class="ask-context" data-testid="ask-context" aria-busy={generating}>
	<div class="ask-setup" data-testid="ask-setup">
		{#if setup}
			<div class="setup-head"><span>The agent explained this first</span><Button variant="ghost" size="content" tone="inherit" hoverFill="none" touchTarget class="ask-cite" data-testid="ask-setup-jump" ariaLabel={`Go to the agent's setup${setup.surfacingOrdinal === undefined ? '' : ` #${setup.surfacingOrdinal}`}`} onclick={() => { if (setup) oncite(setup); }}>{setup.surfacingOrdinal === undefined ? "Earlier reply" : `#${setup.surfacingOrdinal}`} · {surfaceTime((setup.createdAt ?? start) - start)} ›</Button></div>
			<div class="setup-prose md-content">{@html setup.html}</div>
		{:else}
			<p class="no-setup">No earlier explanation found.</p>
		{/if}
	</div>
	{#if explanation}
		<section class="ask-explanation" data-testid="ask-explanation" aria-label="In plain words">
			<div class="explanation-head"><b>✦ In plain words</b><span>{explanation.model === "opus" ? "Opus" : "Sonnet"}</span></div>
			<h5>So far</h5><p>{@render prose(explanation.soFar)}</p>
			<h5>What came up</h5><p>{@render prose(explanation.whatCameUp)}</p>
			{#each explanation.options as option}
				<div class="ask-choice"><b>{@render prose(option.label)}{#if option.recommended}<span class="recommendation">Agent leans this way</span>{/if}</b><p>{@render prose(option.explanation)}</p><Button variant="accent-soft" size="content" touchTarget class="ask-action" onclick={() => onReplyToAsk(option.label)}>↩ Reply with this</Button></div>
			{/each}
			<div class="ask-actions"><Button variant="ghost" size="content" tone="inherit" touchTarget class="ask-action bg-chip" onclick={() => onReplyToAsk()}>↩ Something else…</Button></div>
			{#if explanation.unanswered}<p class="unanswered">{@render prose(explanation.unanswered)}</p>{/if}
		</section>
	{:else}
		<div class="ask-actions">
			<Button variant={!setup ? "accent-soft" : "ghost"} size="content" tone={!setup ? "accent" : "inherit"} touchTarget class="ask-action {!setup ? '' : 'bg-chip'}" data-testid="ask-explain" data-primary={!setup} disabled={!enabled || generating} onclick={onexplain}>{generating ? "✦ Explaining…" : error ? "✦ Try again" : "✦ Explain options"}</Button>
		</div>
	{/if}
	{#if !enabled && !explanation}<p class="explain-off">Explain uses the summary model. Enable it in Settings › Surfacing.</p>{/if}
	{#if error}<p role="alert" class="explain-error">{error}</p>{/if}
</div>

<style>
	.ask-context { overflow-wrap:anywhere; }
	.ask-setup, .ask-explanation { margin-top:10px; padding:10px 12px; border-radius:10px; background:var(--color-turn-bg); }
	.setup-head { display:flex; flex-wrap:wrap; align-items:center; gap:8px; font-size:12.5px; font-weight:600; }
	.setup-prose { margin-top:6px; font-size:13.5px; line-height:1.55; color:var(--color-text-secondary); }
	.setup-prose :global(p:last-child) { margin-bottom:0; }
	/* Phones show the setup's opening; its jump opens the whole message. */
	@media(max-width:599px) { .setup-prose { display:-webkit-box; -webkit-line-clamp:4; line-clamp:4; -webkit-box-orient:vertical; overflow:hidden; } }
	.no-setup { margin:0; font-size:13.5px; line-height:1.55; font-style:italic; color:var(--color-text-muted); }
	.ask-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:10px; }
	.ask-context :global(.ask-action) { justify-self:start; min-height:28px; padding:0 12px; border-radius:999px; font-size:13px; font-weight:500; }
	.explanation-head { display:flex; align-items:center; gap:8px; font-size:13.5px; }
	.explanation-head b { font-weight:600; }
	.explanation-head span { margin-left:auto; color:var(--color-text-muted); font:12px var(--font-mono); }
	h5 { margin:12px 0 0; font:500 11px var(--font-mono); letter-spacing:.05em; text-transform:uppercase; color:var(--color-text-muted); }
	.ask-explanation p { margin:6px 0 0; font-size:13.5px; line-height:1.55; color:var(--color-text-secondary); white-space:pre-wrap; }
	.ask-choice { display:grid; gap:2px; margin-top:8px; padding:9px 10px 10px 12px; border-radius:9px; background:var(--color-bg); }
	.ask-choice > b { display:flex; flex-wrap:wrap; align-items:center; gap:8px; font-size:13.5px; font-weight:600; }
	.ask-choice p { margin:0; font-size:13px; }
	.ask-choice :global(.ask-action) { margin-top:6px; }
	.recommendation { padding:2px 6px; border-radius:5px; background:var(--color-chip); font:10px var(--font-mono); color:var(--color-text-muted); }
	.ask-explanation .ask-actions { margin-top:8px; }
	.ask-explanation .unanswered, .explain-off { font-size:12.5px; color:var(--color-text-muted); }
	.explain-error { margin-top:6px; color:var(--color-error); font-size:12px; }
	.ask-context :global(code) { padding:1px 5px; border-radius:5px; background:var(--color-chip); font:12px var(--font-mono); }
	.ask-context :global(.ask-cite) { display:inline-flex; align-items:center; justify-content:center; margin-left:2px; padding:0 6px; border-radius:999px; background:var(--color-chip); color:var(--color-text-secondary); font:500 11px/18px var(--font-mono); vertical-align:1px; }
	.ask-context :global([data-ask="true"]) { background:color-mix(in srgb,var(--color-status-ask) 18%,transparent); color:var(--color-status-ask); }
	.ask-context :global([data-unread="true"]:not([data-ask="true"])) { background:color-mix(in srgb,var(--color-accent) 18%,transparent); color:var(--color-accent); }
	.ask-context :global([data-followed="true"]) { outline:1px dashed currentColor; outline-offset:-1px; background:transparent; }
	.ask-context :global(.ask-cite:hover), .ask-context :global(.ask-cite:focus-visible) { background:var(--color-accent); color:var(--color-bg); }
</style>
