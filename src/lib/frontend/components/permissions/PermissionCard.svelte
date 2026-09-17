<!-- ─── Permission Card ────────────────────────────────────────────────────── -->
<!-- Displays a permission request with Allow / Always Allow / Deny actions. -->
<!-- Preserves .permission-card class and [data-request-id] for E2E. -->

<script lang="ts">
	import type {
		PermissionRequest,
		ProviderPermissionUpdateDestination,
	} from "../../types.js";
	import Button from "../ui/Button.svelte";
	import { getBrowserClientId } from "../../stores/client-identity.js";
	import { renderMarkdown } from "../../utils/markdown.js";
	import { getCurrentSlug } from "../../stores/router.svelte.js";
	import Surface from "../ui/Surface.svelte";
	import {
		respondPermissionRpc,
		type RespondPermissionRpcInput,
	} from "../../transport/ws-rpc-client.js";
	let { request }: { request: PermissionRequest } = $props();

	let resolved = $state<"allow" | "allow_always" | "deny" | null>(null);
	let showAlwaysOptions = $state(false);

	const destinationLabels: Record<
		ProviderPermissionUpdateDestination,
		{ label: string; description: string }
	> = {
		session: {
			label: "This Claude session",
			description: "Applies until this Claude SDK session ends.",
		},
		localSettings: {
			label: "This checkout",
			description: "Updates .claude/settings.local.json.",
		},
		projectSettings: {
			label: "This project",
			description: "Updates .claude/settings.json.",
		},
		userSettings: {
			label: "My user settings",
			description: "Updates ~/.claude/settings.json.",
		},
		cliArg: {
			label: "This Claude launch",
			description: "Applies through the SDK runtime option Claude suggested.",
		},
	};

	/** Plan mode's approval arrives as an ordinary permission ask for the SDK's
	 *  `ExitPlanMode` tool, which is what gives it a durable audit trail and lets
	 *  it survive a reload. Only the presentation differs: a plan is prose to be
	 *  read, not a tool argument to be glanced at. */
	const isPlanApproval = $derived(request.toolName === "ExitPlanMode");
	const planMarkdown = $derived.by(() => {
		if (!isPlanApproval) return "";
		const plan = request.toolInput?.["plan"];
		return typeof plan === "string" ? plan : "";
	});
	const heading = $derived(
		request.permissionTitle ??
			(isPlanApproval ? "Plan ready for review" : "Permission Required"),
	);
	const toolLabel = $derived(request.permissionDisplayName ?? request.toolName);
	const claudeRememberOptions = $derived.by(() => {
		const suggestions = request.permissionSuggestions ?? [];
		const destinations = new Set<ProviderPermissionUpdateDestination>();
		for (const suggestion of suggestions) {
			destinations.add(suggestion.destination);
		}
		return Array.from(destinations).map((destination) => ({
			destination,
			...destinationLabels[destination],
		}));
	});
	const hasClaudeRememberOptions = $derived(claudeRememberOptions.length > 0);

	// Format tool input for display (unchanged logic)
	const inputDisplay = $derived.by(() => {
		if (isPlanApproval) return "";
		if (!request.toolInput) return "";
		const toolInput = request.toolInput;
		const toolName = request.toolName.toLowerCase();

		if (toolName === "bash" || toolName === "command") {
			const cmd =
				toolInput["command"] ?? toolInput["cmd"] ?? toolInput["input"];
			if (typeof cmd === "string") return cmd;
		}
		if (toolName === "edit" || toolName === "write" || toolName === "read") {
			const path =
				toolInput["file_path"] ?? toolInput["path"] ?? toolInput["file"];
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
		if (isPlanApproval) {
			// "Denied" reads as a refusal; rejecting a plan just sends Claude back
			// to planning, which is the whole point of staying in plan mode.
			return resolved === "deny" ? "Still planning" : "Plan approved \u2713";
		}
		if (resolved === "deny") return "Denied \u2717";
		if (resolved === "allow_always") return "Approved \u2713 (always)";
		return "Approved \u2713";
	});

	const resolvedClass = $derived(
		resolved === "deny" ? "text-error" : "text-success",
	);

	const alwaysPatterns = $derived(request.always ?? []);
	const hasPatterns = $derived(alwaysPatterns.length > 0);

	function sendPermissionResponse(
		input: Omit<
			RespondPermissionRpcInput,
			"projectSlug" | "originId" | "commandId"
		>,
	) {
		const projectSlug = getCurrentSlug();
		if (!projectSlug) return;
		void respondPermissionRpc({
			projectSlug,
			originId: getBrowserClientId(),
			commandId: crypto.randomUUID(),
			...input,
		});
	}

	function handleAllow() {
		if (resolved) return;
		sendPermissionResponse({
			requestId: request.requestId,
			decision: "allow",
		});
		resolved = "allow";
	}

	function handleAlwaysAllowTool() {
		if (resolved) return;
		sendPermissionResponse({
			requestId: request.requestId,
			decision: "allow_always",
			persistScope: "tool",
		});
		resolved = "allow_always";
		showAlwaysOptions = false;
	}

	function handleAlwaysAllowPattern(pattern: string) {
		if (resolved) return;
		sendPermissionResponse({
			requestId: request.requestId,
			decision: "allow_always",
			persistScope: "pattern",
			persistPattern: pattern,
		});
		resolved = "allow_always";
		showAlwaysOptions = false;
	}

	function handleRememberDestination(
		permissionDestination: ProviderPermissionUpdateDestination,
	) {
		if (resolved) return;
		sendPermissionResponse({
			requestId: request.requestId,
			decision: "allow_always",
			permissionDestination,
		});
		resolved = "allow_always";
		showAlwaysOptions = false;
	}

	function handleAlwaysAllow() {
		if (resolved) return;
		if (hasClaudeRememberOptions || hasPatterns) {
			showAlwaysOptions = !showAlwaysOptions;
		} else {
			// No patterns available — default to tool-level
			handleAlwaysAllowTool();
		}
	}

	function handleDeny() {
		if (resolved) return;
		sendPermissionResponse({
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
		<Surface
			variant="raised"
			radius="lg"
			class="permission-card p-3"
	>
		<div class="text-base font-medium mb-2 text-text">
			{heading}
		</div>

		{#if request.permissionDescription}
			<div class="text-xs text-text-secondary mb-2">
				{request.permissionDescription}
			</div>
		{/if}

		{#if !isPlanApproval}
			<div class="font-mono text-xs text-accent mb-1 break-all select-text">
				{toolLabel}
			</div>
		{:else if planMarkdown}
			<div
				data-testid="plan-approval-content"
				class="md-content text-sm leading-[1.7] mb-2.5 bg-code-bg rounded-md p-3 max-h-[420px] overflow-y-auto select-text"
			>
				{@html renderMarkdown(planMarkdown)}
			</div>
		{/if}

		{#if inputDisplay}
			<div
				class="font-mono text-xs text-text-secondary mb-2.5 bg-code-bg rounded-md p-2 max-h-[150px] overflow-y-auto whitespace-pre-wrap break-all select-text"
			>
				{inputDisplay}
			</div>
		{/if}

		{#if !resolved && isPlanApproval}
			<!-- No "always" affordance: remembering an ExitPlanMode approval would
			     auto-exit every future plan, permanently defeating plan mode. -->
			<div class="perm-actions flex gap-2 max-sm:flex-col">
				<button
					class="min-h-[48px] flex-1 px-4 py-2 rounded-lg border cursor-pointer font-sans text-sm font-medium bg-success/10 border-success/20 text-success hover:bg-success/15"
					onclick={handleAllow}
				>
					Approve Plan
				</button>
				<button
					class="min-h-[48px] flex-1 px-4 py-2 rounded-lg border border-border cursor-pointer font-sans text-sm font-medium text-text-secondary hover:bg-bg"
					onclick={handleDeny}
				>
					Keep Planning
				</button>
			</div>
		{:else if !resolved}
			<div class="perm-actions flex gap-2 max-sm:flex-col">
				<Button
					variant="success-soft"
					size="content"
					class="min-h-[48px] flex-1 px-4 py-2 rounded-lg font-sans text-sm font-medium"
					onclick={handleAllow}
				>
					Allow
				</Button>
				<!-- Normalized onto plain `success-soft` (de3.35.2). This used to sit
				     one notch softer than its Allow sibling on all three colours, to
				     de-emphasise the more consequential choice. Aligned rather than
				     given a variant of its own, on two grounds: it was a single-file
				     recipe, which Button.svelte:39-42 says stays local, and the dimming
				     ran the wrong way for contrast — `text-success/70` over a
				     `bg-success/[0.08]` surface was the least readable label on the
				     card. If Always Allow genuinely needs de-emphasis, that is a
				     hierarchy question for the card, not an opacity nudge on one
				     button. -->
				<Button
					variant="success-soft"
					size="content"
					class="min-h-[48px] flex-1 px-4 py-2 rounded-lg font-sans text-sm font-medium"
					onclick={handleAlwaysAllow}
					aria-expanded={hasClaudeRememberOptions || hasPatterns ? showAlwaysOptions : undefined}
				>
					{hasClaudeRememberOptions ? "Remember" : "Always Allow"}{hasClaudeRememberOptions ||
					hasPatterns
						? " \u25BE"
						: ""}
				</Button>
				<Button
					variant="danger-outline"
					size="content"
					class="min-h-[48px] flex-1 px-4 py-2 rounded-lg font-sans text-sm font-medium"
					onclick={handleDeny}
				>
					Deny
				</Button>
			</div>

			{#if showAlwaysOptions}
				<div class="mt-2 flex flex-col gap-1.5">
					{#if hasClaudeRememberOptions}
						<div class="text-xs text-text-secondary mb-0.5">Remember for:</div>
						{#each claudeRememberOptions as option}
							<Button
								variant="ghost"
								size="content"
								layout="flow"
								tone="inherit"
								hoverFill="success-faint"
								class="w-full text-left px-3 py-2 rounded-lg border border-border font-sans text-xs hover:border-success/15"
								onclick={() => handleRememberDestination(option.destination)}
							>
								<span class="block font-medium text-success/80">
									{option.label}
								</span>
								<span class="block text-text-secondary mt-0.5">
									{option.description}
								</span>
							</Button>
						{/each}
					{:else}
						<div class="text-xs text-text-secondary mb-0.5">Always allow:</div>
						<Button
							variant="ghost"
							size="content"
							layout="flow"
							tone="inherit"
							hoverFill="success-faint"
							class="w-full text-left px-3 py-2 rounded-lg border border-success/15 font-sans text-xs font-medium text-success/80"
							onclick={handleAlwaysAllowTool}
						>
							All <span class="font-mono">{request.toolName}</span> operations
						</Button>
						{#each alwaysPatterns as pattern}
							<Button
								variant="ghost"
								size="content"
								layout="flow"
								tone="inherit"
								hoverFill="success-faint"
								class="w-full text-left px-3 py-2 rounded-lg border border-border font-mono text-xs text-text-secondary hover:text-success/80 hover:border-success/15 break-all select-text"
								onclick={() => handleAlwaysAllowPattern(pattern)}
							>
								{pattern}
							</Button>
						{/each}
					{/if}
				</div>
			{/if}
		{:else}
			<div class="perm-resolved text-sm py-2 opacity-60">
				<span class={resolvedClass}>{resolvedText}</span>
			</div>
		{/if}
	</Surface>
</div>
