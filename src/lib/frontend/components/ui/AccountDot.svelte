<!--
  AccountDot — a Claude account's identity colour, fixed for the life of the
  account because it is derived from the instance ID rather than its position
  in a list. It says which account, never how the account is doing: amber and
  red stay out of the palette because they mean a limit everywhere else, and a
  limited account shows that through red text and dimmed rows instead.

  The hues are the theme-invariant fills and project accents, so a dot is the
  same colour in both themes, like a project square.
-->
<script module lang="ts">
	const ACCOUNT_COLOR_CLASSES = [
		"bg-project-1",
		"bg-project-3",
		"bg-fill-green",
		"bg-fill-blue",
		"bg-fill-indigo",
		"bg-project-4",
	] as const;

	const SIZE_CLASSES = { 6: "size-[6px]", 8: "size-[8px]" } as const;

	// FNV-1a: cheap, stable across sessions and browsers, and well spread for
	// the short random IDs instances get.
	function accountColorClass(instanceId: string): string {
		let hash = 0x811c9dc5;
		for (let index = 0; index < instanceId.length; index++)
			hash = Math.imul(hash ^ instanceId.charCodeAt(index), 0x01000193);
		return ACCOUNT_COLOR_CLASSES[(hash >>> 0) % ACCOUNT_COLOR_CLASSES.length] ?? ACCOUNT_COLOR_CLASSES[0];
	}
</script>

<script lang="ts">
	let {
		instanceId,
		size = 8,
		class: className = "",
	}: {
		instanceId: string;
		size?: keyof typeof SIZE_CLASSES | undefined;
		/** Layout only (margin, alignment); the colour and shape are the dot's. */
		class?: string | undefined;
	} = $props();
</script>

<span
	aria-hidden="true"
	data-testid="account-dot"
	data-account={instanceId}
	class="inline-block shrink-0 rounded-full {SIZE_CLASSES[size]} {accountColorClass(instanceId)} {className}"
></span>
