#!/usr/bin/env node
/**
 * Generate mockup fragment HTML files for fidelity testing.
 *
 * Each fragment renders a single component using the same CSS as Storybook
 * and the same text/data as the corresponding story's mock data.
 * Fragment HTML uses the EXACT same Tailwind class names as the Svelte
 * components — the compiled Storybook CSS contains all utility classes.
 *
 * Usage: node scripts/generate-mockup-fragments.mjs
 * Run AFTER: pnpm storybook:build
 */

import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIST = join(import.meta.dirname, "..", "dist", "storybook");
const OUT = join(DIST, "mockup-fragments");

// Find the main CSS file (the largest .css in dist/storybook/assets/)
const assetsDir = join(DIST, "assets");
const cssFiles = readdirSync(assetsDir)
	.filter((f) => f.endsWith(".css"))
	.map((f) => ({ name: f, size: statSync(join(assetsDir, f)).size }))
	.sort((a, b) => b.size - a.size);
const mainCss = cssFiles[0]?.name;
if (!mainCss) {
	console.error("No CSS file found in dist/storybook/assets/");
	process.exit(1);
}
console.log(`Using CSS: assets/${mainCss}`);

mkdirSync(OUT, { recursive: true });

// ─── Design Tokens (from style.css @theme block + conduit.json) ─────────────
const TOKENS = `
:root {
	--color-bg: #18181B;
	--color-bg-alt: #27272A;
	--color-bg-surface: #27272A;
	--color-text: #E4E4E7;
	--color-text-secondary: #A1A1AA;
	--color-text-muted: #71717A;
	--color-text-dimmer: #52525B;
	--color-accent: #FF2D7B;
	--color-accent-hover: #ff4d91;
	--color-accent-bg: rgba(255, 45, 123, 0.12);
	--color-brand-a: #FF2D7B;
	--color-brand-b: #00E5FF;
	--color-brand-a-glow: rgba(255, 45, 123, 0.15);
	--color-brand-b-glow: rgba(0, 229, 255, 0.15);
	--color-border: #3F3F46;
	--color-border-subtle: rgba(255, 255, 255, 0.06);
	--color-code-bg: #131315;
	--color-input-bg: #333338;
	--color-user-bubble: #2c2c30;
	--color-error: #FF4444;
	--color-success: #22C55E;
	--color-warning: #EAB308;
	--color-sidebar-bg: #141416;
	--color-sidebar-hover: #202023;
	--color-sidebar-active: #2a2a2e;
	--color-thinking: #EAB308;
	--color-thinking-bg: rgba(234, 179, 8, 0.06);
	--color-tool: #00E5FF;
	--color-tool-bg: rgba(0, 229, 255, 0.04);
	--color-warning-bg: rgba(234, 179, 8, 0.12);
	--font-brand: 'Chakra Petch', sans-serif;
	--font-mono: 'JetBrains Mono', 'Berkeley Mono', 'IBM Plex Mono', ui-monospace, monospace;
	--font-sans: 'JetBrains Mono', 'Berkeley Mono', 'IBM Plex Mono', ui-monospace, monospace;
}
body {
	background: var(--color-bg);
	color: var(--color-text);
	font-family: var(--font-sans);
	margin: 0;
	padding: 0;
	-webkit-font-smoothing: antialiased;
}
`;

// ─── Fragment Template ──────────────────────────────────────────────────────

function fragment(_id, body, opts = {}) {
	const width = opts.width ?? 1440;
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=${width}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/${mainCss}">
<style>${TOKENS}</style>
</head>
<body>
<div id="storybook-root" style="width: ${width}px;">
${body}
</div>
</body>
</html>`;
}

// ─── Reusable: Static BlockGrid HTML ────────────────────────────────────────
// Mirrors BlockGrid.svelte with inline styles for computed grid dimensions.
// blockSize, gap, cols are numeric. mode: 'static'|'fast'|'animated'.

function blockGridHTML(cols, blockSize, gap, mode = "static") {
	const radius = Math.max(0.5, blockSize / 4);
	const staggerSpread = mode === "fast" ? 1.0 : 1.6;
	const staggerStep = cols > 1 ? staggerSpread / (cols - 1) : 0;
	const duration = mode === "fast" ? 1.4 : 2.4;

	function staticOpacity(index, total) {
		return 1 - (index / total) * 0.9;
	}

	let html = `<div class="inline-grid" style="grid-template-columns: repeat(${cols}, ${blockSize}px); grid-template-rows: repeat(2, ${blockSize}px); gap: ${gap}px;" role="img" aria-label="Conduit loading indicator">`;

	// Top row: pink (brand-a)
	for (let i = 0; i < cols; i++) {
		const styleAttr =
			mode === "static"
				? `width:${blockSize}px;height:${blockSize}px;border-radius:${radius}px;background:var(--color-brand-a);opacity:${staticOpacity(i, cols).toFixed(2)};`
				: `width:${blockSize}px;height:${blockSize}px;border-radius:${radius}px;background:var(--color-brand-a);animation:pixel-cascade-a ${duration}s ease-in-out infinite;animation-delay:${(i * staggerStep).toFixed(3)}s;`;
		html += `<div style="${styleAttr}"></div>`;
	}

	// Bottom row: cyan (brand-b)
	for (let i = 0; i < cols; i++) {
		const revI = cols - 1 - i;
		const styleAttr =
			mode === "static"
				? `width:${blockSize}px;height:${blockSize}px;border-radius:${radius}px;background:var(--color-brand-b);opacity:${staticOpacity(revI, cols).toFixed(2)};`
				: `width:${blockSize}px;height:${blockSize}px;border-radius:${radius}px;background:var(--color-brand-b);animation:pixel-cascade-b ${duration}s ease-in-out infinite;animation-delay:${(revI * staggerStep).toFixed(3)}s;`;
		html += `<div style="${styleAttr}"></div>`;
	}

	html += `</div>`;
	return html;
}

// Shorthand for the small fast spinner used in tool items (cols=5, 1.5px, gap=0.5)
const BLOCK_GRID_FAST_SMALL = blockGridHTML(5, 1.5, 0.5, "fast");

// ─── Reusable: SVG Icons ────────────────────────────────────────────────────

const ICON_CHEVRON_RIGHT = `<svg class="lucide" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>`;
const ICON_CHECK = `<svg class="lucide" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`;
const ICON_CIRCLE_ALERT = `<svg class="lucide" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>`;
const _ICON_CHEVRON_DOWN = `<svg class="lucide" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`;
const ICON_ARROW_UP = `<svg class="lucide" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>`;
const ICON_PLUS = `<svg class="lucide" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
const ICON_SQUARE = `<svg class="lucide" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12"/></svg>`;
const ICON_PANEL_LEFT_OPEN = `<svg class="lucide" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m14 9 3 3-3 3"/></svg>`;
const ICON_SHARE = `<svg class="lucide" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" x2="12" y1="2" y2="15"/></svg>`;
const ICON_MESSAGE_SQUARE = `<svg class="lucide" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;

// ─── Fragment Definitions ───────────────────────────────────────────────────
// Each uses the EXACT same text/data as the corresponding Storybook story,
// and the EXACT same Tailwind class names as the Svelte components.

const fragments = {};

// ─── 1. UserMessage -- Default ──────────────────────────────────────────────
// Source: UserMessage.svelte
// Mock: mockUserMessage = { text: "How do I fix the authentication bug?" }
fragments["chat-usermessage--default"] = fragment(
	"chat-usermessage--default",
	`
<div class="msg-user max-w-[760px] mx-auto mb-3 px-5" data-uuid="msg-user-001">
  <div class="bg-bg-surface rounded-[10px] py-4 px-5 relative glow-brand-a">
    <div class="text-[11px] font-mono font-semibold uppercase tracking-[1.5px] text-brand-a mb-2">You</div>
    <div class="text-[14px] leading-[1.7] break-words whitespace-pre-wrap text-text">How do I fix the authentication bug?</div>
  </div>
</div>`,
);

// ─── 2. ThinkingBlock -- Active ─────────────────────────────────────────────
// Source: ThinkingBlock.svelte ({#if !message.done} branch)
// Mock: mockThinkingActive = { text: "Let me analyze...", done: false }
fragments["chat-thinkingblock--active"] = fragment(
	"chat-thinkingblock--active",
	`
<div class="thinking-block thinking-item max-w-[760px] mx-auto my-1.5 px-5">
  <div class="glow-brand-b bg-bg-surface/80 rounded-[10px] py-2 px-3.5">
    <div class="flex items-center gap-1.5 mb-1.5">
      ${blockGridHTML(5, 2, 0.75, "fast")}
      <span class="text-xs text-brand-b font-medium">Thinking…</span>
    </div>
    <div class="font-mono text-[13px] leading-[1.55] text-text-secondary whitespace-pre-wrap break-words max-h-[200px] overflow-y-auto">Let me analyze the authentication flow to identify the root cause of the token expiry issue...</div>
  </div>
</div>`,
);

// ─── 3. ThinkingBlock -- Completed (collapsed) ─────────────────────────────
// Source: ThinkingBlock.svelte ({:else} done branch — button)
// Mock: mockThinkingDone = { text: "I've analyzed...", duration: 3200, done: true }
fragments["chat-thinkingblock--completed"] = fragment(
	"chat-thinkingblock--completed",
	`
<div class="thinking-block thinking-item done max-w-[760px] mx-auto my-1.5 px-5">
  <button class="thinking-header flex items-center gap-1.5 cursor-pointer py-2 px-3 select-none glow-brand-b rounded-[10px] text-xs text-text-dimmer hover:bg-bg-surface transition-colors duration-150 w-full text-left">
    <span class="thinking-chevron text-text-dimmer transition-transform duration-200 [&_.lucide]:w-3.5 [&_.lucide]:h-3.5">
      ${ICON_CHEVRON_RIGHT}
    </span>
    <span class="thinking-label">Thought</span>
    <span class="thinking-duration text-[11px] text-text-dimmer font-normal">3.2s</span>
  </button>
</div>`,
);

// ─── Helper: Generic Tool Card ──────────────────────────────────────────────
// Source: ToolItem.svelte — Generic Tool Card section
// Params: toolName, descText, status, groupRadius, isStandalone

function toolCardHTML({
	toolName,
	descText,
	status,
	groupRadius = "rounded-[10px]",
	isStandalone = true,
}) {
	// bulletClass (from ToolItem.svelte bulletClass derived)
	const bulletClassMap = {
		pending: "bg-text-muted",
		running: "bg-accent animate-[pulse-dot_1.2s_ease-in-out_infinite]",
		completed: "bg-success",
		error: "bg-error",
	};
	const bulletClass = bulletClassMap[status] || "bg-text-muted";

	// statusIconClass (from ToolItem.svelte statusIconClass derived)
	const statusIconClassMap = {
		running: "text-text-muted",
		pending: "text-text-muted",
		error: "text-error",
		completed: "text-text-dimmer",
	};
	const statusIconClass = statusIconClassMap[status] || "text-text-muted";

	// statusIcon
	const statusIconMap = {
		running: null, // uses BlockGrid
		pending: null, // uses BlockGrid
		completed: ICON_CHECK,
		error: ICON_CIRCLE_ALERT,
	};
	const statusIcon = statusIconMap[status];

	// subtitleText (from ToolItem.svelte subtitleText derived)
	const subtitleMap = {
		pending: "Pending…",
		running: "Running…",
		completed: "Done",
		error: "Error",
	};
	const subtitleText = subtitleMap[status] || "";

	// glowClass (from ToolItem.svelte template)
	let glowClass = "";
	if (status === "error") glowClass = "glow-tool-error";
	else if (status === "completed" && !isStandalone)
		glowClass = "glow-tool-completed";
	else if (status === "running") glowClass = "glow-tool-running";

	// bgClass: standalone completed has no bg
	const bgClass = isStandalone && status === "completed" ? "" : "bg-bg-surface";

	// Running shimmer overlay
	const shimmerOverlay =
		status === "running"
			? `<div class="absolute inset-0 pointer-events-none" style="background: linear-gradient(90deg, transparent 0%, rgba(234,179,8,0.04) 50%, transparent 100%); animation: tool-shimmer-slide 2s ease-in-out infinite;"></div>`
			: "";

	// Status icon or BlockGrid
	const statusHTML = statusIcon
		? `<span class="tool-status-icon shrink-0 [&_.lucide]:w-3.5 [&_.lucide]:h-3.5 ${statusIconClass}">${statusIcon}</span>`
		: `${BLOCK_GRID_FAST_SMALL}`;

	// Hide subtitle for standalone completed
	const showSubtitle = !(isStandalone && status === "completed");

	return `
<div class="tool-item max-w-[760px] mx-auto px-5 mt-1.5 mb-1" data-tool-id="tool-mock-001">
  <div class="${bgClass} ${groupRadius} relative overflow-hidden ${glowClass}">
    ${shimmerOverlay}
    <button class="tool-header flex items-center gap-2.5 w-full py-2 px-3 cursor-pointer select-none text-[13px] text-text-secondary hover:bg-[rgba(var(--overlay-rgb),0.03)] transition-colors duration-150 border-none text-left">
      <span class="tool-chevron text-text-dimmer transition-transform duration-200 [&_.lucide]:w-3.5 [&_.lucide]:h-3.5">
        ${ICON_CHEVRON_RIGHT}
      </span>
      <span class="tool-bullet w-2 h-2 rounded-full shrink-0 ${bulletClass}"></span>
      ${statusHTML}
      <span class="tool-name font-medium font-mono text-text">${toolName}</span>
      <span class="tool-desc flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs text-text-dimmer">${descText}</span>
    </button>
    ${
			showSubtitle
				? `<div class="tool-subtitle flex items-center gap-1.5 py-0.5 px-3 pl-4 text-xs italic text-text-dimmer">
      <span class="tool-connector font-mono not-italic text-border">└</span>
      <span class="tool-subtitle-text">${subtitleText}</span>
    </div>`
				: ""
		}
  </div>
</div>`;
}

// ─── 4. ToolItem -- Completed (standalone) ──────────────────────────────────
fragments["chat-toolitem--completed"] = fragment(
	"chat-toolitem--completed",
	toolCardHTML({
		toolName: "Read",
		descText: "/home/user/repo/src/auth.ts",
		status: "completed",
		isStandalone: true,
	}),
);

// ─── 5. ToolItem -- Running ─────────────────────────────────────────────────
fragments["chat-toolitem--running"] = fragment(
	"chat-toolitem--running",
	toolCardHTML({
		toolName: "Edit",
		descText: "/home/user/repo/src/auth.ts",
		status: "running",
		isStandalone: true,
	}),
);

// ─── 6. ToolItem -- Error ───────────────────────────────────────────────────
fragments["chat-toolitem--error-state"] = fragment(
	"chat-toolitem--error-state",
	toolCardHTML({
		toolName: "Bash",
		descText: "cat /src/auth.ts",
		status: "error",
		isStandalone: true,
	}),
);

// ─── 7. ToolItem -- Pending ─────────────────────────────────────────────────
fragments["chat-toolitem--pending"] = fragment(
	"chat-toolitem--pending",
	toolCardHTML({
		toolName: "Read",
		descText: "/home/user/repo/src/auth.ts",
		status: "pending",
		isStandalone: true,
	}),
);

// ─── 8. ResultBar -- Full ───────────────────────────────────────────────────
// Source: ResultBar.svelte
// Mock: mockResultFull = { cost: 0.0142, duration: 8500, inputTokens: 1250, outputTokens: 380, cacheRead: 800 }
fragments["chat-resultbar--full"] = fragment(
	"chat-resultbar--full",
	`
<div class="result-bar turn-meta max-w-[760px] mx-auto mt-1 mb-5 px-5 text-xs text-text-dimmer">
  $0.0142 · 8.5s · 1250 in · 380 out · 800 cache
</div>`,
);

// ─── 9. Header -- Connected ─────────────────────────────────────────────────
// Source: Header.svelte
fragments["layout-header--connected"] = fragment(
	"layout-header--connected",
	`
<div id="header" class="flex items-center justify-between px-5 py-3 min-h-[48px] shrink-0 gap-2">
  <div id="header-left" class="flex items-center gap-2 min-w-0 flex-1">
    <button id="sidebar-expand-btn" class="header-icon-btn" title="Open sidebar">
      ${ICON_PANEL_LEFT_OPEN}
    </button>
    <div id="header-project-scroll" class="min-w-0 flex-1 overflow-x-auto">
      <div class="flex items-center gap-2 whitespace-nowrap">
        <h1 id="project-name" class="text-[15px] font-semibold tracking-[0.08em]" style="font-family: var(--font-brand);">my-project</h1>
      </div>
    </div>
  </div>
  <div id="header-right" class="flex items-center gap-1.5 shrink-0 text-xs text-text-muted">
    <button id="qr-btn" class="header-icon-btn" title="Share">${ICON_SHARE}</button>
    <span id="status" class="status-dot w-[7px] h-[7px] rounded-full shrink-0 bg-success" title="Connected"></span>
  </div>
</div>`,
);

// ─── 10. SessionItem -- Active ──────────────────────────────────────────────
// Source: SessionItem.svelte — active=true, full 1440px width
fragments["features-sessionitem--active"] = fragment(
	"features-sessionitem--active",
	`
<a class="session-item group flex items-center gap-1 py-[7px] px-3 rounded-[10px] cursor-pointer relative text-[13px] transition-colors duration-100 active bg-bg-surface text-text no-underline" style="box-shadow: inset 3px 0 0 var(--color-brand-a), inset 3px 0 12px rgba(255,45,123,0.1);" data-session-id="ses-001">
  <span class="session-item-title flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap group-hover:underline">Test Session</span>
  <span class="session-item-meta shrink-0 text-[11px] text-text-dimmer whitespace-nowrap">30m ago · 12 msgs</span>
</a>`,
);

// ─── 11. SessionItem -- Inactive ────────────────────────────────────────────
// Source: SessionItem.svelte — active=false
fragments["features-sessionitem--inactive"] = fragment(
	"features-sessionitem--inactive",
	`
<a class="session-item group flex items-center gap-1 py-[7px] px-3 rounded-[10px] cursor-pointer relative text-[13px] transition-colors duration-100 text-text-secondary hover:bg-sidebar-hover hover:text-text no-underline" data-session-id="ses-002">
  <span class="session-item-title flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap group-hover:underline">Test Session</span>
  <span class="session-item-meta shrink-0 text-[11px] text-text-dimmer whitespace-nowrap">30m ago · 12 msgs</span>
</a>`,
);

// ─── 12. SessionItem -- Processing ──────────────────────────────────────────
// Source: SessionItem.svelte — active=true, isProcessing=true
fragments["features-sessionitem--processing"] = fragment(
	"features-sessionitem--processing",
	`
<a class="session-item group flex items-center gap-1 py-[7px] px-3 rounded-[10px] cursor-pointer relative text-[13px] transition-colors duration-100 active bg-bg-surface text-text no-underline" style="box-shadow: inset 3px 0 0 var(--color-brand-a), inset 3px 0 12px rgba(255,45,123,0.1);" data-session-id="ses-003">
  <span class="session-processing-dot w-[7px] h-[7px] rounded-full shrink-0 animate-pulse-dot bg-brand-a"></span>
  <span class="session-item-title flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap group-hover:underline">Running CI pipeline checks</span>
  <span class="session-item-meta shrink-0 text-[11px] text-text-dimmer whitespace-nowrap">5m ago · 3 msgs</span>
</a>`,
);

// ─── 13-15. ToolItem -- Grouped Variants ────────────────────────────────────
// Source: ToolItem.svelte groupRadius derived

// 13. First in Group (rounded-t-[10px])
fragments["chat-toolitem--first-in-group"] = fragment(
	"chat-toolitem--first-in-group",
	toolCardHTML({
		toolName: "Read",
		descText: "/home/user/repo/src/auth.ts",
		status: "completed",
		groupRadius: "rounded-t-[10px]",
		isStandalone: false,
	}),
);

// 14. Middle of Group (no rounding)
fragments["chat-toolitem--middle-of-group"] = fragment(
	"chat-toolitem--middle-of-group",
	toolCardHTML({
		toolName: "Edit",
		descText: "/home/user/repo/src/auth.ts",
		status: "running",
		groupRadius: "",
		isStandalone: false,
	}),
);

// 15. Last in Group (rounded-b-[10px])
fragments["chat-toolitem--last-in-group"] = fragment(
	"chat-toolitem--last-in-group",
	toolCardHTML({
		toolName: "Read",
		descText: "/home/user/repo/src/auth.ts",
		status: "completed",
		groupRadius: "rounded-b-[10px]",
		isStandalone: false,
	}),
);

// ─── 16. ToolItem -- Question Running ───────────────────────────────────────
// Source: ToolItem.svelte question branch + QuestionCard.svelte
// Mock: AskUserQuestion, status: "running", inline question card
fragments["chat-toolitem--question-running"] = fragment(
	"chat-toolitem--question-running",
	`
<div class="tool-item max-w-[760px] mx-auto px-5 mt-1.5 mb-1" data-tool-id="tool-q-001">
  <!-- Inline QuestionCard (from QuestionCard.svelte, inline=true so no outer wrapper) -->
  <div class="question-card bg-bg-alt border border-border rounded-xl p-3">
    <div class="question-title text-[13px] font-medium mb-2 text-text">Input Required</div>
    <div class="question-section mb-3 last:mb-2" data-q-idx="0">
      <div class="question-header text-xs font-semibold mb-0.5 text-accent font-mono">Model selection</div>
      <div class="question-text text-sm mb-2 text-text-secondary">Which model would you like to use for this task?</div>
      <div class="question-options flex flex-col gap-1.5">
        <label class="question-option flex items-start gap-2 px-2.5 py-2 rounded-lg cursor-pointer text-sm bg-bg-surface border border-border-subtle transition-[background,border-color] duration-150 hover:border-border hover:bg-bg">
          <input type="radio" name="q-opt" class="mt-0.5 shrink-0 accent-accent">
          <span class="question-option-content flex flex-col gap-0.5">
            <span class="question-option-label text-sm font-medium text-text">Yes, fix it (Recommended)</span>
            <span class="question-option-desc text-xs text-text-muted">Reset the timeout on each SSE event, turning it into an inactivity timeout</span>
          </span>
        </label>
        <label class="question-option flex items-start gap-2 px-2.5 py-2 rounded-lg cursor-pointer text-sm bg-bg-surface border border-border-subtle transition-[background,border-color] duration-150 hover:border-border hover:bg-bg">
          <input type="radio" name="q-opt" class="mt-0.5 shrink-0 accent-accent">
          <span class="question-option-content flex flex-col gap-0.5">
            <span class="question-option-label text-sm font-medium text-text">More details first</span>
            <span class="question-option-desc text-xs text-text-muted">Explain more about the scenarios before proceeding</span>
          </span>
        </label>
      </div>
    </div>
    <div class="question-actions flex gap-2 mt-2 max-sm:flex-col">
      <button class="question-submit-btn min-h-12 flex-1 px-4 py-2 rounded-lg border cursor-pointer text-sm font-medium font-sans border-success/20 bg-success/10 text-success transition-[background] duration-150 hover:enabled:bg-success/15 disabled:opacity-40 disabled:cursor-not-allowed" disabled>Submit</button>
      <button class="question-skip-btn min-h-12 flex-1 px-4 py-2 rounded-lg border cursor-pointer text-sm font-medium font-sans border-border text-error bg-transparent transition-[background] duration-150 hover:bg-error/[0.08]">Skip</button>
    </div>
  </div>
</div>`,
);

// ─── 17. ToolItem -- Question Answered ──────────────────────────────────────
// Source: ToolItem.svelte question completed/historical branch
// Mock: AskUserQuestion, status: "completed", header: "deployment target"
fragments["chat-toolitem--question-answered"] = fragment(
	"chat-toolitem--question-answered",
	`
<div class="tool-item max-w-[760px] mx-auto px-5 mt-1.5 mb-1" data-tool-id="tool-q-002">
  <div class="bg-bg-surface rounded-[10px] relative overflow-hidden glow-tool-completed">
    <!-- Header row (from ToolItem.svelte question-tool-header) -->
    <div class="question-tool-header flex items-center gap-2.5 w-full py-2 px-3 text-[13px] text-text-secondary">
      <span class="tool-bullet w-2 h-2 rounded-full shrink-0 bg-success"></span>
      <span class="tool-status-icon shrink-0 [&_.lucide]:w-3.5 [&_.lucide]:h-3.5 text-text-dimmer">${ICON_CHECK}</span>
      <span class="text-accent [&_.lucide]:w-4 [&_.lucide]:h-4">${ICON_MESSAGE_SQUARE}</span>
      <span class="font-medium text-accent text-xs">Input Required</span>
      <span class="flex-1"></span>
    </div>
    <!-- Question content (read-only) -->
    <div class="px-3 pb-2">
      <div class="question-tool-section">
        <div class="text-xs font-semibold text-accent font-mono mb-0.5">Deployment target</div>
        <div class="text-sm text-text-secondary mb-1.5">Which deployment target should we use?</div>
      </div>
    </div>
    <!-- Subtitle row -->
    <div class="tool-subtitle flex items-center gap-1.5 py-0.5 px-3 pl-4 text-xs italic text-text-dimmer">
      <span class="tool-connector font-mono not-italic text-border">└</span>
      <span class="tool-subtitle-text text-success not-italic">Answered ✓</span>
    </div>
    <!-- Answer display -->
    <div class="font-mono text-xs whitespace-pre-wrap break-all my-0.5 mx-2.5 py-2 px-2.5 bg-code-bg border border-border-subtle rounded-lg text-text-secondary max-h-[200px] overflow-y-auto mb-2">["Yes, fix it (Recommended)"]</div>
  </div>
</div>`,
);

// ─── 18. InputArea -- Empty ─────────────────────────────────────────────────
// Source: InputArea.svelte
// Mock: processing=false, contextPercent=0
fragments["layout-inputarea--empty"] = fragment(
	"layout-inputarea--empty",
	`
<div id="input-area" class="shrink-0 px-4 py-2 pb-[calc(env(safe-area-inset-bottom,0px)+12px)]">
  <div id="input-wrapper" class="max-w-[760px] mx-auto relative">
    <div id="input-row" class="flex flex-col bg-input-bg border border-border rounded-3xl py-1.5 px-1.5 transition-[border-color,box-shadow] duration-200">
      <!-- Textarea row -->
      <div class="flex items-start">
        <textarea id="input" rows="1" placeholder="Message OpenCode&hellip;" autocomplete="off" enterkeyhint="send" class="flex-1 min-w-0 bg-transparent border-none text-text text-base font-sans leading-[1.4] pt-2 pb-1 px-2.5 resize-none outline-none min-h-6 max-h-[120px] overflow-y-auto placeholder:text-text-muted"></textarea>
      </div>
      <!-- Bottom row -->
      <div id="input-bottom" class="flex items-center justify-between gap-1">
        <div id="input-bottom-left" class="flex items-center gap-1 min-w-0">
          <div id="attach-wrap" class="relative shrink-0">
            <button id="attach-btn" type="button" aria-label="Attach" class="w-7 h-7 rounded-md border border-border bg-bg-alt text-text-muted cursor-pointer flex items-center justify-center transition-[background,color] duration-150 hover:bg-bg-surface hover:text-text">${ICON_PLUS}</button>
          </div>
          <div id="agent-selector">
            <button class="inline-flex items-center gap-[2px] h-9 px-2 border-none bg-transparent text-text-muted font-mono text-xs font-medium cursor-pointer whitespace-nowrap transition-[background,color] duration-150 rounded-[10px] max-w-[160px] hover:bg-bg-alt hover:text-text-secondary">
              <span class="overflow-hidden text-ellipsis whitespace-nowrap">code</span>
            </button>
          </div>
          <button class="model-btn inline-flex items-center gap-[2px] h-9 px-2 border-none bg-transparent text-text-muted font-mono text-xs font-medium cursor-pointer whitespace-nowrap transition-[background,color] duration-150 rounded-[10px] max-w-[180px] hover:bg-bg-alt hover:text-text-secondary">
            <span class="overflow-hidden text-ellipsis whitespace-nowrap">Claude Sonnet 4</span>
          </button>
          <button class="inline-flex items-center gap-[2px] h-9 px-2 border-none bg-transparent text-text-dimmer font-mono text-[10px] font-medium cursor-pointer whitespace-nowrap transition-[background,color] duration-150 rounded-[10px] hover:bg-bg-alt hover:text-text-muted" title="Thinking level (high)">
            high
          </button>
        </div>
        <div id="input-bottom-right" class="flex items-center gap-1 shrink-0">
          <button id="send" class="send-btn shrink-0 w-8 h-8 rounded-[10px] border-none bg-brand-a text-white cursor-pointer flex items-center justify-center transition-[background,opacity] duration-150 touch-manipulation hover:not-disabled:opacity-90 disabled:opacity-25 disabled:cursor-default" disabled>${ICON_ARROW_UP}</button>
        </div>
      </div>
    </div>
  </div>
</div>`,
);

// ─── 19. InputArea -- Processing ────────────────────────────────────────────
// Source: InputArea.svelte with isProcessing=true
fragments["layout-inputarea--processing"] = fragment(
	"layout-inputarea--processing",
	`
<div id="input-area" class="shrink-0 px-4 py-2 pb-[calc(env(safe-area-inset-bottom,0px)+12px)]">
  <div id="input-wrapper" class="max-w-[760px] mx-auto relative">
    <div id="input-row" class="flex flex-col bg-input-bg border border-border rounded-3xl py-1.5 px-1.5 transition-[border-color,box-shadow] duration-200">
      <div class="flex items-start">
        <textarea id="input" rows="1" placeholder="Message OpenCode&hellip;" autocomplete="off" enterkeyhint="send" class="flex-1 min-w-0 bg-transparent border-none text-text text-base font-sans leading-[1.4] pt-2 pb-1 px-2.5 resize-none outline-none min-h-6 max-h-[120px] overflow-y-auto placeholder:text-text-muted"></textarea>
      </div>
      <div id="input-bottom" class="flex items-center justify-between gap-1">
        <div id="input-bottom-left" class="flex items-center gap-1 min-w-0">
          <div id="attach-wrap" class="relative shrink-0">
            <button id="attach-btn" type="button" aria-label="Attach" class="w-7 h-7 rounded-md border border-border bg-bg-alt text-text-muted cursor-pointer flex items-center justify-center transition-[background,color] duration-150 hover:bg-bg-surface hover:text-text">${ICON_PLUS}</button>
          </div>
          <div id="agent-selector">
            <button class="inline-flex items-center gap-[2px] h-9 px-2 border-none bg-transparent text-text-muted font-mono text-xs font-medium cursor-pointer whitespace-nowrap transition-[background,color] duration-150 rounded-[10px] max-w-[160px] hover:bg-bg-alt hover:text-text-secondary">
              <span class="overflow-hidden text-ellipsis whitespace-nowrap">code</span>
            </button>
          </div>
          <button class="model-btn inline-flex items-center gap-[2px] h-9 px-2 border-none bg-transparent text-text-muted font-mono text-xs font-medium cursor-pointer whitespace-nowrap transition-[background,color] duration-150 rounded-[10px] max-w-[180px] hover:bg-bg-alt hover:text-text-secondary">
            <span class="overflow-hidden text-ellipsis whitespace-nowrap">Claude Sonnet 4</span>
          </button>
          <button class="inline-flex items-center gap-[2px] h-9 px-2 border-none bg-transparent text-text-dimmer font-mono text-[10px] font-medium cursor-pointer whitespace-nowrap transition-[background,color] duration-150 rounded-[10px] hover:bg-bg-alt hover:text-text-muted" title="Thinking level (high)">
            high
          </button>
        </div>
        <div id="input-bottom-right" class="flex items-center gap-1 shrink-0">
          <button id="send" class="send-btn shrink-0 w-8 h-8 rounded-[10px] border-none bg-brand-a text-white cursor-pointer flex items-center justify-center transition-[background,opacity] duration-150 touch-manipulation hover:not-disabled:opacity-90 disabled:opacity-25 disabled:cursor-default" disabled>${ICON_ARROW_UP}</button>
          <button id="stop" class="shrink-0 w-8 h-8 rounded-[10px] bg-transparent border border-border text-text-muted cursor-pointer flex items-center justify-center transition-[background,color,opacity] duration-150 touch-manipulation hover:bg-bg-alt hover:text-text active:opacity-70" title="Stop generating">${ICON_SQUARE}</button>
        </div>
      </div>
    </div>
  </div>
</div>`,
);

// ─── 20. InputArea -- With Context Bar ──────────────────────────────────────
// Source: InputArea.svelte with showContextMini=true, contextPercent=42
fragments["layout-inputarea--with-context-bar"] = fragment(
	"layout-inputarea--with-context-bar",
	`
<div id="input-area" class="shrink-0 px-4 py-2 pb-[calc(env(safe-area-inset-bottom,0px)+12px)]">
  <div id="input-wrapper" class="max-w-[760px] mx-auto relative">
    <!-- Context usage bar (from InputArea.svelte #context-mini) -->
    <div id="context-mini" class="flex items-center gap-2 pb-1.5 px-2">
      <span class="context-mini-label font-mono text-[10px] font-semibold whitespace-nowrap min-w-6 text-brand-b" id="context-mini-label">42%</span>
      <div class="context-mini-bar flex-1 h-1 rounded-[2px] bg-border overflow-hidden">
        <div class="context-mini-fill h-full rounded-[2px] transition-[width,background-color] duration-300 ease-out bg-brand-b" id="context-mini-fill" style="width: 42%"></div>
      </div>
    </div>
    <div id="input-row" class="flex flex-col bg-input-bg border border-border rounded-3xl py-1.5 px-1.5 transition-[border-color,box-shadow] duration-200">
      <div class="flex items-start">
        <textarea id="input" rows="1" placeholder="Message OpenCode&hellip;" autocomplete="off" enterkeyhint="send" class="flex-1 min-w-0 bg-transparent border-none text-text text-base font-sans leading-[1.4] pt-2 pb-1 px-2.5 resize-none outline-none min-h-6 max-h-[120px] overflow-y-auto placeholder:text-text-muted"></textarea>
      </div>
      <div id="input-bottom" class="flex items-center justify-between gap-1">
        <div id="input-bottom-left" class="flex items-center gap-1 min-w-0">
          <div id="attach-wrap" class="relative shrink-0">
            <button id="attach-btn" type="button" aria-label="Attach" class="w-7 h-7 rounded-md border border-border bg-bg-alt text-text-muted cursor-pointer flex items-center justify-center transition-[background,color] duration-150 hover:bg-bg-surface hover:text-text">${ICON_PLUS}</button>
          </div>
          <div id="agent-selector">
            <button class="inline-flex items-center gap-[2px] h-9 px-2 border-none bg-transparent text-text-muted font-mono text-xs font-medium cursor-pointer whitespace-nowrap transition-[background,color] duration-150 rounded-[10px] max-w-[160px] hover:bg-bg-alt hover:text-text-secondary">
              <span class="overflow-hidden text-ellipsis whitespace-nowrap">code</span>
            </button>
          </div>
          <button class="model-btn inline-flex items-center gap-[2px] h-9 px-2 border-none bg-transparent text-text-muted font-mono text-xs font-medium cursor-pointer whitespace-nowrap transition-[background,color] duration-150 rounded-[10px] max-w-[180px] hover:bg-bg-alt hover:text-text-secondary">
            <span class="overflow-hidden text-ellipsis whitespace-nowrap">Claude Sonnet 4</span>
          </button>
          <button class="inline-flex items-center gap-[2px] h-9 px-2 border-none bg-transparent text-text-dimmer font-mono text-[10px] font-medium cursor-pointer whitespace-nowrap transition-[background,color] duration-150 rounded-[10px] hover:bg-bg-alt hover:text-text-muted" title="Thinking level (high)">
            high
          </button>
        </div>
        <div id="input-bottom-right" class="flex items-center gap-1 shrink-0">
          <button id="send" class="send-btn shrink-0 w-8 h-8 rounded-[10px] border-none bg-brand-a text-white cursor-pointer flex items-center justify-center transition-[background,opacity] duration-150 touch-manipulation hover:not-disabled:opacity-90 disabled:opacity-25 disabled:cursor-default" disabled>${ICON_ARROW_UP}</button>
        </div>
      </div>
    </div>
  </div>
</div>`,
);

// ─── 21. PermissionCard -- Pending ──────────────────────────────────────────
// Source: PermissionCard.svelte
// Mock: mockPermissionPending = { toolName: "bash", requestId: "perm-001" }
fragments["features-permissioncard--pending"] = fragment(
	"features-permissioncard--pending",
	`
<div class="my-2 mx-auto max-w-[760px] px-4" data-request-id="perm-001">
  <div class="permission-card bg-bg-alt border border-border rounded-xl p-3">
    <div class="text-[13px] font-medium mb-2 text-text">Permission Required</div>
    <div class="font-mono text-xs text-accent mb-1 break-all">bash</div>
    <div class="perm-actions flex gap-2 max-sm:flex-col">
      <button class="min-h-[48px] flex-1 px-4 py-2 rounded-lg border cursor-pointer font-sans text-sm font-medium bg-success/10 border-success/20 text-success hover:bg-success/15">Allow</button>
      <button class="min-h-[48px] flex-1 px-4 py-2 rounded-lg border cursor-pointer font-sans text-sm font-medium bg-success/[0.08] border-success/15 text-success/70 hover:bg-success/15">Always Allow</button>
      <button class="min-h-[48px] flex-1 px-4 py-2 rounded-lg border border-border cursor-pointer font-sans text-sm font-medium text-error hover:bg-error/[0.08]">Deny</button>
    </div>
  </div>
</div>`,
);

// ─── 22. ConnectOverlay -- Connecting ────────────────────────────────────────
// Source: ConnectOverlay.svelte + ConduitLogo.svelte (size="loading", animated=true)
fragments["overlays-connectoverlay--connecting"] = fragment(
	"overlays-connectoverlay--connecting",
	`
<div id="connect-overlay" class="connect-overlay fixed inset-0 z-50 flex items-center justify-center bg-bg" style="width:1440px;height:900px;">
  <!-- Radial glow orb -->
  <div class="absolute w-[400px] h-[400px] rounded-full pointer-events-none" style="top:50%;left:50%;transform:translate(-50%,-50%);background:radial-gradient(circle, rgba(255,45,123,0.08) 0%, rgba(0,229,255,0.05) 40%, transparent 70%);"></div>
  <div class="flex flex-col items-center relative z-10" style="gap: 8px;">
    <!-- ConduitLogo (size="loading": text-[28px], blockSize=8, gap=3, cols=10) -->
    <div class="flex flex-col items-center" style="gap: 6px;">
      <span class="font-medium tracking-[0.14em] text-text text-[28px]" style="font-family: var(--font-brand);">conduit</span>
      ${blockGridHTML(10, 8, 3, "animated")}
    </div>
    <!-- Gradient status text -->
    <div class="text-sm font-medium" style="font-family: var(--font-brand); background: linear-gradient(90deg, var(--color-brand-b), var(--color-brand-a)); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;">
      Connecting to OpenCode...
    </div>
  </div>
</div>`,
);

// ─── 23. Header -- Disconnected ─────────────────────────────────────────────
// Source: Header.svelte with status="disconnected"
fragments["layout-header--disconnected"] = fragment(
	"layout-header--disconnected",
	`
<div id="header" class="flex items-center justify-between px-5 py-3 min-h-[48px] shrink-0 gap-2">
  <div id="header-left" class="flex items-center gap-2 min-w-0 flex-1">
    <button id="sidebar-expand-btn" class="header-icon-btn" title="Open sidebar">
      ${ICON_PANEL_LEFT_OPEN}
    </button>
    <div id="header-project-scroll" class="min-w-0 flex-1 overflow-x-auto">
      <div class="flex items-center gap-2 whitespace-nowrap">
        <h1 id="project-name" class="text-[15px] font-semibold tracking-[0.08em]" style="font-family: var(--font-brand);">my-project</h1>
      </div>
    </div>
  </div>
  <div id="header-right" class="flex items-center gap-1.5 shrink-0 text-xs text-text-muted">
    <button id="qr-btn" class="header-icon-btn" title="Share">${ICON_SHARE}</button>
    <span id="status" class="status-dot w-[7px] h-[7px] rounded-full shrink-0 bg-text-muted" title="Disconnected"></span>
  </div>
</div>`,
);

// ─── 24. Header -- Processing ───────────────────────────────────────────────
// Source: Header.svelte with status="processing"
fragments["layout-header--processing"] = fragment(
	"layout-header--processing",
	`
<div id="header" class="flex items-center justify-between px-5 py-3 min-h-[48px] shrink-0 gap-2">
  <div id="header-left" class="flex items-center gap-2 min-w-0 flex-1">
    <button id="sidebar-expand-btn" class="header-icon-btn" title="Open sidebar">
      ${ICON_PANEL_LEFT_OPEN}
    </button>
    <div id="header-project-scroll" class="min-w-0 flex-1 overflow-x-auto">
      <div class="flex items-center gap-2 whitespace-nowrap">
        <h1 id="project-name" class="text-[15px] font-semibold tracking-[0.08em]" style="font-family: var(--font-brand);">my-project</h1>
      </div>
    </div>
  </div>
  <div id="header-right" class="flex items-center gap-1.5 shrink-0 text-xs text-text-muted">
    <button id="qr-btn" class="header-icon-btn" title="Share">${ICON_SHARE}</button>
    <span id="status" class="status-dot w-[7px] h-[7px] rounded-full shrink-0 bg-success animate-[pulse-dot_1.2s_ease-in-out_infinite]" title="Processing..."></span>
  </div>
</div>`,
);

// ─── 25. InputArea -- High Context (85%) ────────────────────────────────────
// Source: InputArea.svelte, contextPercent=85 → bg-warning
fragments["layout-inputarea--high-context"] = fragment(
	"layout-inputarea--high-context",
	`
<div id="input-area" class="shrink-0 px-4 py-2 pb-[calc(env(safe-area-inset-bottom,0px)+12px)]">
  <div id="input-wrapper" class="max-w-[760px] mx-auto relative">
    <div id="context-mini" class="flex items-center gap-2 pb-1.5 px-2">
      <span class="context-mini-label font-mono text-[10px] font-semibold whitespace-nowrap min-w-6 text-warning" id="context-mini-label">85%</span>
      <div class="context-mini-bar flex-1 h-1 rounded-[2px] bg-border overflow-hidden">
        <div class="context-mini-fill h-full rounded-[2px] transition-[width,background-color] duration-300 ease-out bg-warning" id="context-mini-fill" style="width: 85%"></div>
      </div>
    </div>
    <div id="input-row" class="flex flex-col bg-input-bg border border-border rounded-3xl py-1.5 px-1.5 transition-[border-color,box-shadow] duration-200">
      <div class="flex items-start">
        <textarea id="input" rows="1" placeholder="Message OpenCode&hellip;" autocomplete="off" enterkeyhint="send" class="flex-1 min-w-0 bg-transparent border-none text-text text-base font-sans leading-[1.4] pt-2 pb-1 px-2.5 resize-none outline-none min-h-6 max-h-[120px] overflow-y-auto placeholder:text-text-muted"></textarea>
      </div>
      <div id="input-bottom" class="flex items-center justify-between gap-1">
        <div id="input-bottom-left" class="flex items-center gap-1 min-w-0">
          <div id="attach-wrap" class="relative shrink-0">
            <button id="attach-btn" type="button" aria-label="Attach" class="w-7 h-7 rounded-md border border-border bg-bg-alt text-text-muted cursor-pointer flex items-center justify-center transition-[background,color] duration-150 hover:bg-bg-surface hover:text-text">${ICON_PLUS}</button>
          </div>
          <div id="agent-selector">
            <button class="inline-flex items-center gap-[2px] h-9 px-2 border-none bg-transparent text-text-muted font-mono text-xs font-medium cursor-pointer whitespace-nowrap transition-[background,color] duration-150 rounded-[10px] max-w-[160px] hover:bg-bg-alt hover:text-text-secondary">
              <span class="overflow-hidden text-ellipsis whitespace-nowrap">code</span>
            </button>
          </div>
          <button class="model-btn inline-flex items-center gap-[2px] h-9 px-2 border-none bg-transparent text-text-muted font-mono text-xs font-medium cursor-pointer whitespace-nowrap transition-[background,color] duration-150 rounded-[10px] max-w-[180px] hover:bg-bg-alt hover:text-text-secondary">
            <span class="overflow-hidden text-ellipsis whitespace-nowrap">Claude Sonnet 4</span>
          </button>
          <button class="inline-flex items-center gap-[2px] h-9 px-2 border-none bg-transparent text-text-dimmer font-mono text-[10px] font-medium cursor-pointer whitespace-nowrap transition-[background,color] duration-150 rounded-[10px] hover:bg-bg-alt hover:text-text-muted" title="Thinking level (high)">
            high
          </button>
        </div>
        <div id="input-bottom-right" class="flex items-center gap-1 shrink-0">
          <button id="send" class="send-btn shrink-0 w-8 h-8 rounded-[10px] border-none bg-brand-a text-white cursor-pointer flex items-center justify-center transition-[background,opacity] duration-150 touch-manipulation hover:not-disabled:opacity-90 disabled:opacity-25 disabled:cursor-default" disabled>${ICON_ARROW_UP}</button>
        </div>
      </div>
    </div>
  </div>
</div>`,
);

// ─── 26. InputArea -- Critical Context (97%) ────────────────────────────────
// Source: InputArea.svelte, contextPercent=97 → bg-brand-a
fragments["layout-inputarea--critical-context"] = fragment(
	"layout-inputarea--critical-context",
	`
<div id="input-area" class="shrink-0 px-4 py-2 pb-[calc(env(safe-area-inset-bottom,0px)+12px)]">
  <div id="input-wrapper" class="max-w-[760px] mx-auto relative">
    <div id="context-mini" class="flex items-center gap-2 pb-1.5 px-2">
      <span class="context-mini-label font-mono text-[10px] font-semibold whitespace-nowrap min-w-6 text-brand-a" id="context-mini-label">97%</span>
      <div class="context-mini-bar flex-1 h-1 rounded-[2px] bg-border overflow-hidden">
        <div class="context-mini-fill h-full rounded-[2px] transition-[width,background-color] duration-300 ease-out bg-brand-a" id="context-mini-fill" style="width: 97%"></div>
      </div>
    </div>
    <div id="input-row" class="flex flex-col bg-input-bg border border-border rounded-3xl py-1.5 px-1.5 transition-[border-color,box-shadow] duration-200">
      <div class="flex items-start">
        <textarea id="input" rows="1" placeholder="Message OpenCode&hellip;" autocomplete="off" enterkeyhint="send" class="flex-1 min-w-0 bg-transparent border-none text-text text-base font-sans leading-[1.4] pt-2 pb-1 px-2.5 resize-none outline-none min-h-6 max-h-[120px] overflow-y-auto placeholder:text-text-muted"></textarea>
      </div>
      <div id="input-bottom" class="flex items-center justify-between gap-1">
        <div id="input-bottom-left" class="flex items-center gap-1 min-w-0">
          <div id="attach-wrap" class="relative shrink-0">
            <button id="attach-btn" type="button" aria-label="Attach" class="w-7 h-7 rounded-md border border-border bg-bg-alt text-text-muted cursor-pointer flex items-center justify-center transition-[background,color] duration-150 hover:bg-bg-surface hover:text-text">${ICON_PLUS}</button>
          </div>
          <div id="agent-selector">
            <button class="inline-flex items-center gap-[2px] h-9 px-2 border-none bg-transparent text-text-muted font-mono text-xs font-medium cursor-pointer whitespace-nowrap transition-[background,color] duration-150 rounded-[10px] max-w-[160px] hover:bg-bg-alt hover:text-text-secondary">
              <span class="overflow-hidden text-ellipsis whitespace-nowrap">code</span>
            </button>
          </div>
          <button class="model-btn inline-flex items-center gap-[2px] h-9 px-2 border-none bg-transparent text-text-muted font-mono text-xs font-medium cursor-pointer whitespace-nowrap transition-[background,color] duration-150 rounded-[10px] max-w-[180px] hover:bg-bg-alt hover:text-text-secondary">
            <span class="overflow-hidden text-ellipsis whitespace-nowrap">Claude Sonnet 4</span>
          </button>
          <button class="inline-flex items-center gap-[2px] h-9 px-2 border-none bg-transparent text-text-dimmer font-mono text-[10px] font-medium cursor-pointer whitespace-nowrap transition-[background,color] duration-150 rounded-[10px] hover:bg-bg-alt hover:text-text-muted" title="Thinking level (high)">
            high
          </button>
        </div>
        <div id="input-bottom-right" class="flex items-center gap-1 shrink-0">
          <button id="send" class="send-btn shrink-0 w-8 h-8 rounded-[10px] border-none bg-brand-a text-white cursor-pointer flex items-center justify-center transition-[background,opacity] duration-150 touch-manipulation hover:not-disabled:opacity-90 disabled:opacity-25 disabled:cursor-default" disabled>${ICON_ARROW_UP}</button>
        </div>
      </div>
    </div>
  </div>
</div>`,
);

// ─── Write all fragments ────────────────────────────────────────────────────
let count = 0;
for (const [id, html] of Object.entries(fragments)) {
	const filepath = join(OUT, `${id}.html`);
	writeFileSync(filepath, html);
	count++;
}

console.log(
	`Generated ${count} mockup fragments in dist/storybook/mockup-fragments/`,
);
