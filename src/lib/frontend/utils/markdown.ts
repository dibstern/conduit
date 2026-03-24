// ─── Markdown Rendering ──────────────────────────────────────────────────────
// Renders markdown to sanitized HTML using marked + DOMPurify (npm packages).
// highlight.js and mermaid are handled post-render by components.

import DOMPurify from "dompurify";
import { marked, Renderer } from "marked";

// Configure marked: GFM enabled, no automatic line breaks.
// Custom table renderer wraps tables in a scroll container with shadow
// affordance divs so that wide tables scroll instead of overflowing.
marked.use({
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
 * Uses marked for parsing and DOMPurify for XSS prevention.
 */
export function renderMarkdown(text: string): string {
	const html = marked.parse(text, { async: false }) as string;
	return DOMPurify.sanitize(html);
}
