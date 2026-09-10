<script lang="ts">
	import ComposerVariant from "./ComposerVariant.svelte";
</script>

<!--
	Manual comparison view only. The 3G.2 capture harness drives the SINGLE-variant
	stories instead: a screen reader walks the whole document, so putting both arms
	on one page would interleave their announcements and produce a transcript that
	cannot be attributed to either variant.
-->
<div class="flex flex-wrap gap-8">
	<ComposerVariant variant="A" />
	<ComposerVariant variant="B" />
</div>
