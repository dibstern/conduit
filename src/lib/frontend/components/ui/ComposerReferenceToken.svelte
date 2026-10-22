<!--
  A reply reference painted in the composer backdrop. `label` is exactly the
  text the transparent textarea holds for the token, so every glyph, the ×
  included, sits under its caret position. The × is the only live part of the
  backdrop: positioned above the textarea to take the click, while the keyboard
  removes the token with Backspace or Delete in the textarea itself.
-->
<script lang="ts">
	let { label, colour, ask = false, title, onremove }: { label: string; colour?: string | undefined; ask?: boolean; title: string; onremove: () => void } = $props();

	const cut = $derived(label.lastIndexOf("×"));
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<span class="reference-token" class:category={!!colour} class:ask style:--category-colour={colour} data-testid="surfacing-ref-token" {title}>{label.slice(0, cut)}<span class="remove" data-testid="surfacing-ref-remove" title="Remove reference" onpointerdown={(event) => event.preventDefault()} onclick={onremove}>×</span>{label.slice(cut + 1)}</span>

<style>
	/* Vertical padding paints a 26px chip without moving a glyph; the label's
	   own narrow no-break spaces are its horizontal padding. */
	.reference-token {
		padding: 3px 0;
		border-radius: 8px;
		background: var(--color-chip);
		-webkit-box-decoration-break: clone;
		box-decoration-break: clone;
	}
	.category {
		color: var(--category-colour);
		background: color-mix(in srgb, var(--category-colour) 14%, transparent);
	}
	.ask {
		background: color-mix(in srgb, var(--color-cat-ask) 16%, transparent);
	}
	.remove {
		position: relative;
		z-index: 20;
		pointer-events: auto;
		cursor: pointer;
		color: var(--color-text-muted);
	}
	.remove:hover {
		color: var(--color-text);
	}
	/* A wider hit area that leaves the text metrics alone. */
	.remove::before {
		content: "";
		position: absolute;
		inset: -2px -6px;
	}
	@media (pointer: coarse) {
		.remove::before {
			inset: -6px -10px;
		}
	}
</style>
