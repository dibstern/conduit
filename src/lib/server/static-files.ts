// ─── Static File Serving ─────────────────────────────────────────────────────
// Extracted from http-router.ts — handles static asset serving with content-hash
// cache control, SPA fallback, and directory traversal prevention.

import { readFile, stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, join, resolve } from "node:path";
import {
	getCacheControl,
	MIME_TYPES,
} from "../domain/server/Services/static-file-handler.js";

// ─── Cache Control ──────────────────────────────────────────────────────────

// One source of truth — the hash pattern is subtle enough that a second copy
// silently drifts, which is how every asset ended up uncacheable.
export { getCacheControl };

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
