// ─── README Media Generator ──────────────────────────────────────────────────
// Generates all media assets referenced in README.md.
//
// Usage:
//   pnpm generate:media           # Build + generate all
//   pnpm generate:media -- main-ui  # Generate single scene
//
// Prerequisites:
//   - ffmpeg (brew install ffmpeg) — required for GIF generation

import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import type { SceneDefinition } from "./scene-runner.js";
import {
	buildFrontend,
	MEDIA_DIR,
	runScenes,
	startPreview,
} from "./scene-runner.js";

// ── Scene imports ────────────────────────────────────────────────────────────
// These files don't exist yet (Tasks 3–6). Loaded dynamically so the entry
// point can at least parse when scenes haven't been created.

async function loadScenes(): Promise<SceneDefinition[]> {
	const sceneModules = [
		"./scenes/main-ui.js",
		"./scenes/approval.js",
		"./scenes/dashboard.js",
		"./scenes/setup.js",
		"./scenes/split.js",
		"./scenes/sidebar.js",
	];

	const scenes: SceneDefinition[] = [];
	for (const mod of sceneModules) {
		try {
			const m = await import(mod);
			// Each module exports a single scene as the first *Scene export
			const scene = Object.values(m).find(
				(v): v is SceneDefinition =>
					typeof v === "object" && v !== null && "config" in v && "run" in v,
			);
			if (scene) scenes.push(scene);
		} catch {
			// Scene not yet implemented — skip silently
		}
	}
	return scenes;
}

async function main(): Promise<void> {
	console.log("README Media Generator\n");

	// Check for ffmpeg
	try {
		execSync("which ffmpeg", { stdio: "pipe" });
	} catch {
		console.error("Error: ffmpeg is required for GIF generation.");
		console.error("Install: brew install ffmpeg");
		process.exit(1);
	}

	const allScenes = await loadScenes();

	if (allScenes.length === 0) {
		console.error("No scenes found. Scene modules may not be implemented yet.");
		process.exit(1);
	}

	// Parse optional filter arg
	const filter = process.argv[2];
	const scenes = filter
		? allScenes.filter((s) => s.config.name === filter)
		: allScenes;

	if (scenes.length === 0) {
		console.error(`Unknown scene: ${filter}`);
		console.error(
			`Available: ${allScenes.map((s) => s.config.name).join(", ")}`,
		);
		process.exit(1);
	}

	// Clean video temp dir
	rmSync(path.join(MEDIA_DIR, "_video_tmp"), { recursive: true, force: true });

	// Build frontend
	buildFrontend();

	// Start preview server
	const previewProc = await startPreview();

	try {
		await runScenes(scenes);
	} finally {
		previewProc.kill();
		// Clean video temp dir
		rmSync(path.join(MEDIA_DIR, "_video_tmp"), {
			recursive: true,
			force: true,
		});
	}

	console.log("\nDone.");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
