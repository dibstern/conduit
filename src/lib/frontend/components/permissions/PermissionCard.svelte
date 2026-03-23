<!-- ─── Permission Card ────────────────────────────────────────────────────── -->
<!-- Displays a permission request with Allow / Always Allow / Deny actions. -->
<!-- Preserves .permission-card class and [data-request-id] for E2E. -->

<script lang="ts">
	import type { PermissionRequest } from "../../types.js";
	import { wsSend } from "../../stores/ws.svelte.js";
	let { request }: { request: PermissionRequest } = $props();

	let resolved = $state<"allow" | "allow_always" | "deny" | null>(null);
	let showAlwaysOptions = $state(false);

	// Format tool input for display (unchanged logic)
	const inputDisplay = $derived.by(() => {
		if (!request.toolInput) return "";
		const toolInput = request.toolInput;
		const toolName = request.toolName.toLowerCase();

		if (toolName === "bash" || toolName === "command") {
			const cmd = toolInput.command ?? toolInput.cmd ?? toolInput.input;
			if (typeof cmd === "string") return cmd;
		}
		if (toolName === "edit" || toolName === "write" || toolName === "read") {
			const path = toolInput.file_path ?? toolInput.path ?? toolInput.file;
			if (typeof path === "string") return path;
		}

		const entries = Object.entries(toolInput).filter(
			([_, v]) => v !== undefined && v !== null,
		);
		if (entries.length === 0) return "";
		return entries
			.map(
				([k, v]) =>
					`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`,
			)
			.join("\n")
			.slice(0, 500);
	});

	const resolvedText = $derived.by(() => {
		if (!resolved) return "";
		if (resolved === "deny") return "Denied \u2717";
		if (resolved === "allow_always") return "Approved \u2713 (always)";
		return "Approved \u2713";
	});

	const resolvedClass = $derived(
		resolved === "deny" ? "text-error" : "text-success",
	);

	const alwaysPatterns = $derived(request.always ?? []);
	const hasPatterns = $derived(alwaysPatterns.length > 0);

	function handleAllow() {
		if (resolved) return;
		wsSend({
			type: "permission_response",
			requestId: request.requestId,
			decision: "allow",
		});
		resolved = "allow";
	}

	function handleAlwaysAllowTool() {
		if (resolved) return;
		wsSend({
			type: "permission_response",
			requestId: request.requestId,
			decision: "allow_always",
			persistScope: "tool",
		});
		resolved = "allow_always";
		showAlwaysOptions = false;
	}

	function handleAlwaysAllowPattern(pattern: string) {
		if (resolved) return;
		wsSend({
			type: "permission_response",
			requestId: request.requestId,
			decision: "allow_always",
			persistScope: "pattern",
			persistPattern: pattern,
		});
		resolved = "allow_always";
		showAlwaysOptions = false;
	}

	function handleAlwaysAllow() {
		if (resolved) return;
		if (hasPatterns) {
			showAlwaysOptions = !showAlwaysOptions;
		} else {
			// No patterns available — default to tool-level
			handleAlwaysAllowTool();
		}
	}

	function handleDeny() {
		if (resolved) return;
		wsSend({
			type: "permission_response",
			requestId: request.requestId,
			decision: "deny",
		});
		resolved = "deny";
	}
</script>

<div
	class="my-2 mx-auto max-w-[760px] px-4"
	data-request-id={request.requestId}
>
	<div
		class="permission-card bg-bg-alt border border-border rounded-xl p-3"
	>
		<div class="text-base font-medium mb-2 text-text">
			Permission Required
		</div>

		<div class="font-mono text-xs text-accent mb-1 break-all">
			{request.toolName}
		</div>

		{#if inputDisplay}
			<div
				class="font-mono text-xs text-text-secondary mb-2.5 bg-code-bg rounded-md p-2 max-h-[150px] overflow-y-auto whitespace-pre-wrap break-all"
			>
				{inputDisplay}
			</div>
		{/if}

		{#if !resolved}
			<div class="perm-actions flex gap-2 max-sm:flex-col">
				<button
					class="min-h-[48px] flex-1 px-4 py-2 rounded-lg border cursor-pointer font-sans text-sm font-medium bg-success/10 border-success/20 text-success hover:bg-success/15"
					onclick={handleAllow}
				>
					Allow
				</button>
				<button
					class="min-h-[48px] flex-1 px-4 py-2 rounded-lg border cursor-pointer font-sans text-sm font-medium bg-success/[0.08] border-success/15 text-success/70 hover:bg-success/15"
					onclick={handleAlwaysAllow}
				>
					Always Allow{hasPatterns ? " \u25BE" : ""}
				</button>
				<button
					class="min-h-[48px] flex-1 px-4 py-2 rounded-lg border border-border cursor-pointer font-sans text-sm font-medium text-error hover:bg-error/[0.08]"
					onclick={handleDeny}
				>
					Deny
				</button>
			</div>

			{#if showAlwaysOptions}
				<div class="mt-2 flex flex-col gap-1.5">
					<div class="text-xs text-text-secondary mb-0.5">Always allow:</div>
					<button
						class="w-full text-left px-3 py-2 rounded-lg border border-success/15 cursor-pointer font-sans text-xs font-medium text-success/80 hover:bg-success/[0.06]"
						onclick={handleAlwaysAllowTool}
					>
						All <span class="font-mono">{request.toolName}</span> operations
					</button>
					{#each alwaysPatterns as pattern}
						<button
							class="w-full text-left px-3 py-2 rounded-lg border border-border cursor-pointer font-mono text-xs text-text-secondary hover:bg-success/[0.06] hover:text-success/80 hover:border-success/15 break-all"
							onclick={() => handleAlwaysAllowPattern(pattern)}
						>
							{pattern}
						</button>
					{/each}
				</div>
			{/if}
		{:else}
			<div class="perm-resolved text-sm py-2 opacity-60">
				<span class={resolvedClass}>{resolvedText}</span>
			</div>
		{/if}
	</div>
</div>
