// Failure modes: stale rollout links retain the old history index, while
// repeated preparation must preserve an index for the current rollout folder.
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
	codexAccountHome,
	prepareCodexAccount,
} from "../../../../src/lib/provider/codex/codex-home.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe("named Codex rollout homes", () => {
	it.each([
		false,
		true,
	])("migrates an ambient sessions link and preserves a current index: already linked = %s", async (alreadyLinked) => {
		const root = mkdtempSync(join(tmpdir(), "codex-home-"));
		roots.push(root);
		const configDir = join(root, "conduit");
		const base = join(root, "ambient");
		const sessions = join(configDir, "codex", "sessions");
		const account = { id: "work" };
		const home = codexAccountHome(account, configDir);
		mkdirSync(home, { recursive: true });
		mkdirSync(join(base, "sessions"), { recursive: true });
		if (alreadyLinked) mkdirSync(sessions, { recursive: true, mode: 0o700 });
		symlinkSync(
			alreadyLinked ? sessions : join(base, "sessions"),
			join(home, "sessions"),
		);
		const indexes = [
			"state_5.sqlite",
			"state_5.sqlite-wal",
			"state_5.sqlite-shm",
			"state_6.sqlite",
		];
		const retained = [
			"auth.json",
			"models_cache.json",
			"state_5.sqlite.backup",
			"other.sqlite",
		];
		for (const name of [...indexes, ...retained])
			writeFileSync(join(home, name), "fixture");
		const { ino } = lstatSync(join(home, "sessions"));

		await Effect.runPromise(
			prepareCodexAccount(account, configDir, { CODEX_HOME: base }),
		);
		expect(realpathSync(join(home, "sessions"))).toBe(realpathSync(sessions));
		expect(lstatSync(sessions).mode & 0o777).toBe(0o700);
		for (const name of indexes)
			expect(existsSync(join(home, name)), name).toBe(alreadyLinked);
		for (const name of retained)
			expect(existsSync(join(home, name)), name).toBe(true);
		if (alreadyLinked) expect(lstatSync(join(home, "sessions")).ino).toBe(ino);
		for (const name of ["config.toml", "AGENTS.md"])
			writeFileSync(join(base, name), "fixture");
		for (const name of ["skills", "config.toml", "AGENTS.md"]) {
			expect(realpathSync(join(home, name))).toBe(
				realpathSync(join(base, name)),
			);
		}
		writeFileSync(join(home, "state_7.sqlite"), "current index");
		await Effect.runPromise(
			prepareCodexAccount(account, configDir, { CODEX_HOME: base }),
		);
		expect(existsSync(join(home, "state_7.sqlite"))).toBe(true);
	});
});
