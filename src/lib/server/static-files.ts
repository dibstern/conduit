// ─── Static File Serving ─────────────────────────────────────────────────────
// Extracted from http-router.ts — handles static asset serving with content-hash
// cache control, SPA fallback, and directory traversal prevention.

import { readFile, stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, join, resolve } from "node:path";
import { MIME_TYPES } from "./http-router.js";

// ─── Cache Control ──────────────────────────────────────────────────────────

/** Cache-control header value based on whether the file path contains a content hash. */
export function getCacheControl(filePath: string): string {
	return filePath.includes(".") && /\.[a-f0-9]{8,}\./.test(filePath)
		? "public, max-age=31536000, immutable"
		: "public, max-age=0, must-revalidate";
}

// ─── File Serving ───────────────────────────────────────────────────────────

/** Serve a static file with SPA fallback. */
export async function serveStaticFile(
	staticDir: string,
	res: ServerResponse,
	filePath: string,
): Promise<void> {
	if (!filePath || filePath === "") filePath = "index.html";

	// Prevent directory traversal
	const resolved = resolve(staticDir, filePath);
	if (!resolved.startsWith(resolve(staticDir))) {
		res.writeHead(403, { "Content-Type": "text/plain" });
		res.end("Forbidden");
		return;
	}

	try {
		const fileStat = await stat(resolved);
		if (fileStat.isDirectory()) {
			return serveStaticFile(staticDir, res, join(filePath, "index.html"));
		}

		const content = await readFile(resolved);
		const ext = extname(resolved).toLowerCase();
		const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

		res.writeHead(200, {
			"Content-Type": contentType,
			"Content-Length": content.length,
			"Cache-Control": getCacheControl(filePath),
		});
		res.end(content);
	} catch (err) {
		// SPA fallback: try index.html if original file not found
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			if (filePath !== "index.html") {
				try {
					const indexPath = resolve(staticDir, "index.html");
					const content = await readFile(indexPath);
					res.writeHead(200, {
						"Content-Type": "text/html; charset=utf-8",
						"Cache-Control": "public, max-age=0, must-revalidate",
					});
					res.end(content);
					return;
				} catch {
					// index.html also doesn't exist
				}
			}
			res.writeHead(404, { "Content-Type": "text/plain" });
			res.end("Not Found");
		} else {
			throw err;
		}
	}
}

/** Try to serve a static file. Returns true if served, false otherwise. */
export async function tryServeStatic(
	staticDir: string,
	res: ServerResponse,
	filePath: string,
): Promise<boolean> {
	const resolved = resolve(staticDir, filePath);
	if (!resolved.startsWith(resolve(staticDir))) return false;
	try {
		const s = await stat(resolved);
		if (!s.isFile()) return false;
		const content = await readFile(resolved);
		const ext = extname(resolved).toLowerCase();
		const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
		res.writeHead(200, {
			"Content-Type": contentType,
			"Content-Length": content.length,
			"Cache-Control": getCacheControl(filePath),
		});
		res.end(content);
		return true;
	} catch {
		return false;
	}
}
