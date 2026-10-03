<!-- OpenCode's mark (opencode.ai favicon geometry). Drawn from the text colour
     so it stays legible in both themes; the inner square is a faded tint. -->
<script lang="ts">
	let { size = 16, class: className = "" }: { size?: number; class?: string } = $props();
</script>

<svg width={size} height={size} viewBox="64 64 384 384" class={className} aria-hidden="true">
	<path d="M320 224V352H192V224H320Z" fill="color-mix(in srgb, var(--color-text) 35%, transparent)" />
	<path fill-rule="evenodd" d="M384 416H128V96H384V416ZM320 160H192V352H320V160Z" fill="var(--color-text)" />
</svg>
