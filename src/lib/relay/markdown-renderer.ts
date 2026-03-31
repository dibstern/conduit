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

// Lazy-initialized JSDOM + DOMPurify — avoids ~300-500ms of jsdom startup
// at module load time. The first call to renderMarkdownServer() pays the
// cost; subsequent calls reuse the cached instances.
let _purify: ReturnType<typeof createDOMPurify> | undefined;
let _serverMarked: Marked | undefined;

function getPurify(): ReturnType<typeof createDOMPurify> {
	if (!_purify) {
		const jsdomWindow = new JSDOM("").window;
		_purify = createDOMPurify(jsdomWindow as unknown as WindowLike);
	}
	return _purify;
}

function getServerMarked(): Marked {
	if (!_serverMarked) {
		_serverMarked = new Marked({
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
	}
	return _serverMarked;
}

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
	const html = getServerMarked().parse(text, { async: false }) as string;
	return getPurify().sanitize(html);
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
