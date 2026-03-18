// ─── Markdown Rendering ──────────────────────────────────────────────────────
// Renders markdown to sanitized HTML using marked + DOMPurify (npm packages).
// highlight.js and mermaid are handled post-render by components.

import DOMPurify from "dompurify";
import { marked } from "marked";

// Configure marked: GFM enabled, no automatic line breaks
marked.use({ gfm: true, breaks: false });

/**
 * Render markdown text to sanitized HTML.
 * Uses marked for parsing and DOMPurify for XSS prevention.
 */
export function renderMarkdown(text: string): string {
	const html = marked.parse(text, { async: false }) as string;
	return DOMPurify.sanitize(html);
}
