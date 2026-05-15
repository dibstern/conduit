import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startForegroundDaemon } from "../../../src/lib/domain/daemon/Layers/daemon-foreground.js";

describe("startForegroundDaemon", () => {
	it("starts an Effect-backed foreground handle with isolated config", async () => {
		const root = mkdtempSync(join(tmpdir(), "conduit-foreground-"));
		const configDir = join(root, "config");
		const staticDir = join(root, "static");
		const projectDir = join(root, "project");
		mkdirSync(staticDir);
		mkdirSync(projectDir);
		writeFileSync(join(staticDir, "index.html"), "<html>ok</html>", {
			flag: "w",
		});

		const daemon = await startForegroundDaemon({
			port: 0,
			configDir,
			socketPath: join(root, "relay.sock"),
			pidPath: join(root, "daemon.pid"),
			staticDir,
			tlsEnabled: false,
			smartDefault: false,
			logLevel: "error",
			logFormat: "json",
		});

		try {
			expect(daemon.port).toBeGreaterThan(0);
			expect(daemon.onboardingPort).toBeNull();

			const project = await daemon.addProject(projectDir, "foreground-project");
			expect(project.slug).toBe("foreground-project");

			const status = daemon.getStatus();
			expect(status.projectCount).toBe(1);
			expect(status.projects.map((p) => p.slug)).toEqual([
				"foreground-project",
			]);
			expect(daemon.getProjects().map((p) => p.slug)).toEqual([
				"foreground-project",
			]);
		} finally {
			await daemon.stop();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
