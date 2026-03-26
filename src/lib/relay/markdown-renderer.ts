// ─── Server-Side Markdown Rendering ──────────────────────────────────────────
// Renders markdown to sanitized HTML on the server so clients don't have to.
// Uses the same marked config as the frontend for visual parity.
// Does NOT run hljs (CPU-intensive) — that's handled lazily on the client.
//
// Uses jsdom + dompurify factory pattern because:
// - jsdom was already a devDep in the project (promoted to production dep)
// - dompurify's default export crashes in Node without a window object
// - The factory pattern (createDOMPurify(window)) works with dompurify 3.3.1

import createDOMPurify, { type WindowLike } from "dompurify";
import { JSDOM } from "jsdom";
import { Marked, Renderer } from "marked";

import type { HistoryMessage } from "../shared-types.js";

// Create a single JSDOM window for DOMPurify — reused across all calls.
// This is safe because DOMPurify is synchronous and single-threaded in Node.
// Cast: jsdom's DOMWindow has all properties DOMPurify needs at runtime,
// but the TypeScript types don't structurally match WindowLike.
const jsdomWindow = new JSDOM("").window;
const purify = createDOMPurify(jsdomWindow as unknown as WindowLike);

// Use a dedicated Marked instance (not the global singleton) to avoid
// shared-state conflicts if other server-side code imports marked.
// Config mirrors the frontend's marked.use({ gfm: true, breaks: false })
// plus the custom table renderer that wraps tables in scroll containers
// (must match the frontend's markdown.ts renderer for visual parity).
const serverMarked = new Marked({
	gfm: true,
	breaks: false,
	renderer: {
		table(token) {
			const tableHtml = Renderer.prototype.table.call(this, token);
			return (
				'<div class="table-scroll-container">' +
				'<div class="table-scroll">' +
				tableHtml +
				"</div>" +
				'<div class="table-shadow table-shadow-left"></div>' +
				'<div class="table-shadow table-shadow-right"></div>' +
				"</div>"
			);
		},
	},
});

/**
 * Render markdown text to sanitized HTML.
 * Server-side equivalent of the frontend's renderMarkdown().
 *
 * @param text Raw markdown text
 * @returns Sanitized HTML string, or empty string for falsy input
 */
export function renderMarkdownServer(text: string): string {
	if (!text) return "";
	// { async: false } ensures synchronous return (Marked.parse returns
	// string | Promise<string> — without this flag, TypeScript can't
	// narrow the return type to string).
	const html = serverMarked.parse(text, { async: false }) as string;
	return purify.sanitize(html);
}

/**
 * Pre-render markdown for all assistant text parts in a message array.
 * Mutates the messages in-place (adds `renderedHtml` to text parts).
 *
 * Used by all 3 history-sending call sites:
 * - handleViewSession (REST fallback path)
 * - handleLoadMoreHistory
 * - client-init.ts (initial connection REST fallback)
 */
export function preRenderHistoryMessages(messages: HistoryMessage[]): void {
	for (const msg of messages) {
		if (msg.role === "assistant" && msg.parts) {
			for (const part of msg.parts) {
				if (part.type === "text" && part.text) {
					try {
						part.renderedHtml = renderMarkdownServer(part.text);
					} catch {
						// Skip pre-rendering for this part — client will render client-side
					}
				}
			}
		}
	}
}
