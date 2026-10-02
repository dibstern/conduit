<!--
  Stands in for ChatLayout: records the project slug visible when the child
  initialises, which is when ChatLayout opens its daemon socket.
-->
<script lang="ts">
	import { getCurrentSlug } from "../../src/lib/frontend/stores/router.svelte.js";

	const slugAtMount = getCurrentSlug();
</script>

<p data-testid="slug-at-mount">{slugAtMount ?? "none"}</p>
