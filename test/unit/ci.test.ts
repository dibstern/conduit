// ─── Tests: CI/CD Pipeline (Ticket 0.6) ──────────────────────────────────────
//
// Verifies CI workflow, lefthook config, and package.json integration.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..", "..");

function readFile(relativePath: string): string {
	const fullPath = resolve(ROOT, relativePath);
	return readFileSync(fullPath, "utf-8");
}

describe("Ticket 0.6 — CI/CD Pipeline", () => {
	// ─── CI Workflow ──────────────────────────────────────────────────────

	describe("GitHub Actions CI workflow", () => {
		it("ci.yml exists", () => {
			const exists = existsSync(resolve(ROOT, ".github/workflows/ci.yml"));
			expect(exists).toBe(true);
		});

		it("ci.yml has correct trigger events", () => {
			const content = readFile(".github/workflows/ci.yml");
			expect(content).toContain("push:");
			expect(content).toContain("branches: [main]");
			expect(content).toContain("pull_request:");
		});

		it("ci.yml uses actions/checkout@v4", () => {
			const content = readFile(".github/workflows/ci.yml");
			expect(content).toContain("actions/checkout@v4");
		});

		it("ci.yml uses actions/setup-node@v4 with node 22", () => {
			const content = readFile(".github/workflows/ci.yml");
			expect(content).toContain("actions/setup-node@v4");
			expect(content).toContain("node-version: '22'");
		});

		it("ci.yml uses pnpm/action-setup@v4", () => {
			const content = readFile(".github/workflows/ci.yml");
			expect(content).toContain("pnpm/action-setup@v4");
		});

		it("ci.yml caches pnpm store", () => {
			const content = readFile(".github/workflows/ci.yml");
			expect(content).toContain("actions/cache@v4");
			expect(content).toContain("~/.pnpm-store");
			expect(content).toContain("pnpm-lock.yaml");
		});

		it("ci.yml runs pnpm install --frozen-lockfile", () => {
			const content = readFile(".github/workflows/ci.yml");
			expect(content).toContain("pnpm install --frozen-lockfile");
		});

		it("ci.yml runs all four check steps in order", () => {
			const content = readFile(".github/workflows/ci.yml");
			const checkIdx = content.indexOf("pnpm check");
			const lintIdx = content.indexOf("pnpm lint");
			const testIdx = content.indexOf("pnpm test");
			const buildIdx = content.indexOf("pnpm build");

			expect(checkIdx).toBeGreaterThan(-1);
			expect(lintIdx).toBeGreaterThan(-1);
			expect(testIdx).toBeGreaterThan(-1);
			expect(buildIdx).toBeGreaterThan(-1);

			// Verify ordering
			expect(checkIdx).toBeLessThan(lintIdx);
			expect(lintIdx).toBeLessThan(testIdx);
			expect(testIdx).toBeLessThan(buildIdx);
		});

		it("ci.yml runs on ubuntu-latest", () => {
			const content = readFile(".github/workflows/ci.yml");
			expect(content).toContain("ubuntu-latest");
		});
	});

	// ─── Lefthook Config ──────────────────────────────────────────────────

	describe("Lefthook pre-commit config", () => {
		it("lefthook.yml exists", () => {
			const exists = existsSync(resolve(ROOT, "lefthook.yml"));
			expect(exists).toBe(true);
		});

		it("lefthook.yml has pre-commit hooks", () => {
			const content = readFile("lefthook.yml");
			expect(content).toContain("pre-commit:");
		});

		it("lefthook.yml runs lint", () => {
			const content = readFile("lefthook.yml");
			expect(content).toContain("pnpm lint");
		});

		it("lefthook.yml runs typecheck", () => {
			const content = readFile("lefthook.yml");
			expect(content).toContain("pnpm check");
		});

		it("lefthook.yml runs tests", () => {
			const content = readFile("lefthook.yml");
			expect(content).toContain("pnpm test");
		});

		it("lefthook.yml runs build", () => {
			const content = readFile("lefthook.yml");
			expect(content).toContain("pnpm build");
		});
	});

	// ─── CI ↔ Pre-commit Parity ─────────────────────────────────────────

	describe("CI ↔ pre-commit parity", () => {
		it("every CI run step has a matching lefthook pre-commit command", () => {
			const ci = readFile(".github/workflows/ci.yml");
			const hooks = readFile("lefthook.yml");

			// Extract "run: pnpm <script>" lines from CI (skip install)
			const ciSteps = [...ci.matchAll(/^\s*- run:\s*pnpm\s+(\S+)/gm)]
				.map((m) => m[1])
				.filter((s) => s !== "install");

			for (const step of ciSteps) {
				expect(
					hooks,
					`CI runs "pnpm ${step}" but lefthook.yml has no matching pre-commit command`,
				).toContain(`pnpm ${step}`);
			}
		});
	});

	describe("package.json integration", () => {
		it("package.json has prepare script for lefthook", () => {
			const content = readFile("package.json");
			const pkg = JSON.parse(content);
			expect(pkg.scripts.prepare).toBe("lefthook install || true");
		});

		it("package.json has @evilmartians/lefthook in devDependencies", () => {
			const content = readFile("package.json");
			const pkg = JSON.parse(content);
			expect(pkg.devDependencies["@evilmartians/lefthook"]).toBeDefined();
		});

		it("package.json has all required CI scripts", () => {
			const content = readFile("package.json");
			const pkg = JSON.parse(content);
			expect(pkg.scripts.check).toBeDefined();
			expect(pkg.scripts.lint).toBeDefined();
			expect(pkg.scripts.test).toBeDefined();
			expect(pkg.scripts.build).toBeDefined();
		});
	});
});
