<!--
  StatusBox — the tinted result strip the setup steps print under each action.

  Five hand-written copies of this exact recipe lived in StepPwa and StepPush
  (conduit-test-m8ww). They were not there by accident: the content is
  sometimes markup or a conditional, and the old `message: string` prop could
  only take text, so anything richer than a sentence had to fork the markup.
  Content is a snippet now, which is what lets those five come home.

  The `style="border-width: 1px"` hack is gone with them. The class list
  carried a border COLOUR and no width, so the width had to be forced inline;
  `border` says the same thing in the same place as everything else.
-->

<script lang="ts">
	import type { Snippet } from "svelte";
	import type { StatusVariant } from "../../utils/setup-utils.js";
	import Surface from "../ui/Surface.svelte";

	let {
		status,
		children,
	}: {
		status: StatusVariant;
		children: Snippet;
	} = $props();

	const statusClasses = $derived.by(() => {
		if (status === "ok")
			return "bg-success/10 text-success border-success/15";
		if (status === "warn") return "bg-bg-alt text-text border-border";
		return "bg-bg-alt text-text-muted border-border";
	});
</script>

<!-- `bare` with the default `padding="none"`: the tone is per-status and
     px-4 py-3 is off Surface's scale, so both stay here and Surface emits
     nothing that could collide with either. -->
<Surface
	variant="bare"
	radius="panel"
	class="flex items-center gap-2 px-4 py-3 text-base my-4 border {statusClasses}"
>
	{@render children()}
</Surface>
