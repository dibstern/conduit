<!-- The background-tasks mark: a 5x2 grid of blinking blocks in currentColor. -->
<span aria-hidden="true" class="task-glyph">{#each Array(10) as _, i (i)}<i></i>{/each}</span>

<style>
	.task-glyph {
		display: inline-grid;
		flex: none;
		grid-template-columns: repeat(5, 2px);
		grid-auto-rows: 2px;
		gap: 1px;
	}
	.task-glyph i {
		background: currentColor;
		border-radius: 0.5px;
		animation: task-glyph-blink 1.1s steps(2) infinite;
	}
	.task-glyph i:nth-child(3n) { animation-delay: -0.35s; }
	.task-glyph i:nth-child(4n + 1) { animation-delay: -0.7s; }
	.task-glyph i:nth-child(5n + 2) { animation-delay: -0.2s; }
	@keyframes task-glyph-blink { 50% { opacity: 0.25; } }
	@media (prefers-reduced-motion: reduce) { .task-glyph i { animation: none; } }
</style>
