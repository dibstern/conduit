// ─── Unit Tests: TLS Certificate Management (Ticket 8.2) ────────────────────
//
// Tests:
// isRoutableIP (8 tests):
//   T1:  Returns true for 10.0.0.1
//   T2:  Returns true for 192.168.1.1
//   T3:  Returns true for 172.16.0.1
//   T4:  Returns true for 100.100.1.1 (Tailscale CGNAT)
//   T5:  Returns false for 8.8.8.8
//   T6:  Returns false for 1.1.1.1
//   T7:  Returns false for 172.32.0.1 (outside private range)
//   T8:  Returns false for 100.128.0.1 (outside CGNAT range)
//
// getAllIPs (4 tests):
//   T9:  Returns routable IPs from mock interfaces
//   T10: Filters out internal/loopback
//   T11: Handles empty interfaces
//   T12: Returns empty array when no interfaces
//
// getTailscaleIP (4 tests):
//   T13: Prefers tailscale0 interface
//   T14: Falls back to utun interface
//   T15: Falls back to any 100.x
//   T16: Returns null when no Tailscale
//
// hasTailscale (3 tests):
//   T17: Returns true when Tailscale IP found
//   T18: Returns false when no Tailscale
//   T19: Passes networkInterfaces through
//
// hasMkcert (3 tests):
//   T20: Returns true when mkcert succeeds
//   T21: Returns false when exec throws
//   T22: Uses injectable exec
//
// getMkcertCaRoot (2 tests):
//   T23: Returns trimmed path
//   T24: Returns null when exec throws
//
// ensureCerts (9 tests):
//   T25: Returns null when mkcert not available and no certs on disk
//   T25b: Returns existing certs when mkcert unavailable but certs on disk
//   T26: Generates certs on first run
//   T27: Returns existing certs if IPs match
//   T28: Regenerates when IPs change
//   T29: Creates certs directory if missing
//   T30: Returns correct TlsCerts shape
//   T31: Handles exec errors gracefully (mkcert generation fails)
//   T32: Includes all IPs + localhost in cert generation command

import type * as os from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
	ensureCerts,
	getAllIPs,
	getMkcertCaRoot,
	getTailscaleIP,
	hasMkcert,
	hasTailscale,
	isRoutableIP,
} from "../../../src/lib/cli/tls.js";

// ─── Mock helpers ────────────────────────────────────────────────────────────

type NetworkInterfaces = NodeJS.Dict<os.NetworkInterfaceInfo[]>;

function mockNetworkInterfaces(
	ifaces: NetworkInterfaces,
): () => NetworkInterfaces {
	return () => ifaces;
}

function makeIPv4(address: string, internal = false): os.NetworkInterfaceInfo {
	return {
		address,
		netmask: "255.255.255.0",
		family: "IPv4",
		mac: "00:00:00:00:00:00",
		internal,
		cidr: `${address}/24`,
	};
}

/** Create a mock fs that tracks calls */
function createMockFs(files: Record<string, string | Buffer> = {}) {
	return {
		readFileSync: vi.fn((p: string) => {
			const key = typeof p === "string" ? p : String(p);
			if (key in files) return files[key];
			throw new Error(`ENOENT: ${key}`);
		}) as unknown as typeof import("node:fs").readFileSync,
		existsSync: vi.fn((p: string) => {
			const key = typeof p === "string" ? p : String(p);
			return key in files;
		}) as unknown as typeof import("node:fs").existsSync,
		mkdirSync: vi.fn() as unknown as typeof import("node:fs").mkdirSync,
	};
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Ticket 8.2 — TLS Certificate Management", () => {
	// ─── isRoutableIP ────────────────────────────────────────────────────

	describe("isRoutableIP", () => {
		it("T1: returns true for 10.0.0.1 (Class A private)", () => {
			expect(isRoutableIP("10.0.0.1")).toBe(true);
		});

		it("T2: returns true for 192.168.1.1 (Class C private)", () => {
			expect(isRoutableIP("192.168.1.1")).toBe(true);
		});

		it("T3: returns true for 172.16.0.1 (Class B private)", () => {
			expect(isRoutableIP("172.16.0.1")).toBe(true);
		});

		it("T4: returns true for 100.100.1.1 (Tailscale CGNAT)", () => {
			expect(isRoutableIP("100.100.1.1")).toBe(true);
		});

		it("T5: returns false for 8.8.8.8 (public)", () => {
			expect(isRoutableIP("8.8.8.8")).toBe(false);
		});

		it("T6: returns false for 1.1.1.1 (public)", () => {
			expect(isRoutableIP("1.1.1.1")).toBe(false);
		});

		it("T7: returns false for 172.32.0.1 (outside Class B private)", () => {
			expect(isRoutableIP("172.32.0.1")).toBe(false);
		});

		it("T8: returns false for 100.128.0.1 (outside CGNAT range)", () => {
			expect(isRoutableIP("100.128.0.1")).toBe(false);
		});
	});

	// ─── getAllIPs ────────────────────────────────────────────────────────

	describe("getAllIPs", () => {
		it("T9: returns routable IPs from mock interfaces", () => {
			const ni = mockNetworkInterfaces({
				eth0: [makeIPv4("192.168.1.100")],
				wlan0: [makeIPv4("10.0.0.5")],
			});
			const ips = getAllIPs({ networkInterfaces: ni });
			expect(ips).toContain("192.168.1.100");
			expect(ips).toContain("10.0.0.5");
			expect(ips).toHaveLength(2);
		});

		it("T10: filters out internal/loopback addresses", () => {
			const ni = mockNetworkInterfaces({
				lo: [makeIPv4("127.0.0.1", true)],
				eth0: [makeIPv4("192.168.1.100")],
			});
			const ips = getAllIPs({ networkInterfaces: ni });
			expect(ips).not.toContain("127.0.0.1");
			expect(ips).toContain("192.168.1.100");
			expect(ips).toHaveLength(1);
		});

		it("T11: handles empty interface arrays", () => {
			const ni = mockNetworkInterfaces({
				eth0: [],
				wlan0: [makeIPv4("10.0.0.1")],
			});
			const ips = getAllIPs({ networkInterfaces: ni });
			expect(ips).toEqual(["10.0.0.1"]);
		});

		it("T12: returns empty array when no interfaces", () => {
			const ni = mockNetworkInterfaces({});
			const ips = getAllIPs({ networkInterfaces: ni });
			expect(ips).toEqual([]);
		});
	});

	// ─── getTailscaleIP ──────────────────────────────────────────────────

	describe("getTailscaleIP", () => {
		it("T13: prefers tailscale0 interface", () => {
			const ni = mockNetworkInterfaces({
				tailscale0: [makeIPv4("100.100.1.1")],
				eth0: [makeIPv4("100.64.0.5")],
			});
			expect(getTailscaleIP({ networkInterfaces: ni })).toBe("100.100.1.1");
		});

		it("T14: falls back to utun interface", () => {
			const ni = mockNetworkInterfaces({
				utun3: [makeIPv4("100.80.0.1")],
				eth0: [makeIPv4("192.168.1.1")],
			});
			expect(getTailscaleIP({ networkInterfaces: ni })).toBe("100.80.0.1");
		});

		it("T15: falls back to any 100.x address", () => {
			const ni = mockNetworkInterfaces({
				eth0: [makeIPv4("100.64.0.5")],
				wlan0: [makeIPv4("192.168.1.1")],
			});
			expect(getTailscaleIP({ networkInterfaces: ni })).toBe("100.64.0.5");
		});

		it("T16: returns null when no Tailscale", () => {
			const ni = mockNetworkInterfaces({
				eth0: [makeIPv4("192.168.1.1")],
				wlan0: [makeIPv4("10.0.0.5")],
			});
			expect(getTailscaleIP({ networkInterfaces: ni })).toBeNull();
		});
	});

	// ─── hasTailscale ────────────────────────────────────────────────────

	describe("hasTailscale", () => {
		it("T17: returns true when Tailscale IP found", () => {
			const ni = mockNetworkInterfaces({
				tailscale0: [makeIPv4("100.100.1.1")],
			});
			expect(hasTailscale({ networkInterfaces: ni })).toBe(true);
		});

		it("T18: returns false when no Tailscale", () => {
			const ni = mockNetworkInterfaces({
				eth0: [makeIPv4("192.168.1.1")],
			});
			expect(hasTailscale({ networkInterfaces: ni })).toBe(false);
		});

		it("T19: passes networkInterfaces through to getTailscaleIP", () => {
			const niSpy = vi.fn(() => ({
				tailscale0: [makeIPv4("100.100.1.1")],
			})) as unknown as () => NetworkInterfaces;
			hasTailscale({ networkInterfaces: niSpy });
			expect(niSpy).toHaveBeenCalled();
		});
	});

	// ─── hasMkcert ───────────────────────────────────────────────────────

	describe("hasMkcert", () => {
		it("T20: returns true when mkcert succeeds", async () => {
			const exec = vi.fn(() => "/home/user/.local/share/mkcert\n");
			expect(await hasMkcert({ exec })).toBe(true);
		});

		it("T21: returns false when exec throws", async () => {
			const exec = vi.fn(() => {
				throw new Error("command not found: mkcert");
			});
			expect(await hasMkcert({ exec })).toBe(false);
		});

		it("T22: calls exec with correct command", async () => {
			const exec = vi.fn(() => "/path/to/caroot\n");
			await hasMkcert({ exec });
			expect(exec).toHaveBeenCalledWith("mkcert -CAROOT");
		});
	});

	// ─── getMkcertCaRoot ─────────────────────────────────────────────────

	describe("getMkcertCaRoot", () => {
		it("T23: returns trimmed path", async () => {
			const exec = vi.fn(() => "  /home/user/.local/share/mkcert  \n");
			expect(await getMkcertCaRoot({ exec })).toBe(
				"/home/user/.local/share/mkcert",
			);
		});

		it("T24: returns null when exec throws", async () => {
			const exec = vi.fn(() => {
				throw new Error("command not found");
			});
			expect(await getMkcertCaRoot({ exec })).toBeNull();
		});
	});

	// ─── ensureCerts ─────────────────────────────────────────────────────

	describe("ensureCerts", () => {
		it("T25: returns null when mkcert not available and no certs on disk", async () => {
			const mockFs = createMockFs({});
			const exec = vi.fn((cmd: string) => {
				if (cmd === "mkcert -CAROOT") throw new Error("not found");
				return "";
			});
			const result = await ensureCerts({
				exec,
				fs: mockFs,
				configDir: "/tmp/no-certs",
			});
			expect(result).toBeNull();
		});

		it("T25b: returns existing certs when mkcert unavailable but certs on disk", async () => {
			const keyContent = Buffer.from("EXISTING-KEY");
			const certContent = Buffer.from("EXISTING-CERT");
			const mockFs = createMockFs({
				"/tmp/test-relay/certs/key.pem": keyContent,
				"/tmp/test-relay/certs/cert.pem": certContent,
			});

			const exec = vi.fn((cmd: string) => {
				if (cmd === "mkcert -CAROOT") throw new Error("not found");
				if (cmd.startsWith("openssl x509")) {
					// Cert does not cover the current IP
					return "Subject: CN = localhost";
				}
				return "";
			});

			const ni = mockNetworkInterfaces({
				eth0: [makeIPv4("192.168.1.50")],
			});

			const result = await ensureCerts({
				exec,
				fs: mockFs,
				networkInterfaces: ni,
				configDir: "/tmp/test-relay",
			});

			expect(result).not.toBeNull();
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(result!.key).toEqual(Buffer.from(keyContent));
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(result!.cert).toEqual(Buffer.from(certContent));
			// No mkcert and no local rootCA.pem → caRoot is null
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(result!.caRoot).toBeNull();
		});

		it("T26: generates certs on first run", async () => {
			const mockFs = createMockFs({});
			const execCalls: string[] = [];
			const exec = vi.fn((cmd: string): string => {
				execCalls.push(cmd);
				if (cmd === "mkcert -CAROOT") return "/ca/root\n";
				if (cmd.startsWith("mkcert -key-file")) {
					// Simulate mkcert writing certs
					const files = mockFs.existsSync as unknown as ReturnType<
						typeof vi.fn
					>;
					files.mockImplementation((p: string) => {
						if (p.endsWith("key.pem") || p.endsWith("cert.pem")) return true;
						if (p.endsWith("rootCA.pem")) return true;
						return false;
					});
					const read = mockFs.readFileSync as unknown as ReturnType<
						typeof vi.fn
					>;
					read.mockImplementation((p: string) => {
						if (typeof p === "string" && p.endsWith("key.pem"))
							return Buffer.from("KEY");
						if (typeof p === "string" && p.endsWith("cert.pem"))
							return Buffer.from("CERT");
						throw new Error("ENOENT");
					});
					return "created certs";
				}
				return "";
			});
			const ni = mockNetworkInterfaces({
				eth0: [makeIPv4("192.168.1.50")],
			});

			const result = await ensureCerts({
				exec,
				fs: mockFs,
				networkInterfaces: ni,
				configDir: "/tmp/test-relay",
			});

			expect(result).not.toBeNull();
			// Verify mkcert was called to generate
			const mkcertCall = execCalls.find((c) =>
				c.startsWith("mkcert -key-file"),
			);
			expect(mkcertCall).toBeDefined();
			expect(mkcertCall).toContain("192.168.1.50");
		});

		it("T27: returns existing certs if IPs match", async () => {
			const keyContent = Buffer.from("EXISTING-KEY");
			const certContent = Buffer.from("EXISTING-CERT");
			const mockFs = createMockFs({
				"/tmp/test-relay/certs/key.pem": keyContent,
				"/tmp/test-relay/certs/cert.pem": certContent,
				"/ca/root/rootCA.pem": Buffer.from("CA"),
			});

			const exec = vi.fn((cmd: string): string => {
				if (cmd === "mkcert -CAROOT") return "/ca/root\n";
				if (cmd.startsWith("openssl x509")) {
					// Return cert text containing all IPs
					return "Subject Alternative Name: IP Address:192.168.1.50, IP Address:10.0.0.1";
				}
				return "";
			});

			const ni = mockNetworkInterfaces({
				eth0: [makeIPv4("192.168.1.50")],
				wlan0: [makeIPv4("10.0.0.1")],
			});

			const result = await ensureCerts({
				exec,
				fs: mockFs,
				networkInterfaces: ni,
				configDir: "/tmp/test-relay",
			});

			expect(result).not.toBeNull();
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(result!.key).toEqual(Buffer.from(keyContent));
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(result!.cert).toEqual(Buffer.from(certContent));
			// Verify mkcert was NOT called to regenerate
			const mkcertGenCall = exec.mock.calls.find(
				([c]: [string]) =>
					typeof c === "string" && c.startsWith("mkcert -key-file"),
			);
			expect(mkcertGenCall).toBeUndefined();
		});

		it("T28: regenerates when IPs change", async () => {
			const execCalls: string[] = [];
			const mockFs = createMockFs({
				"/tmp/test-relay/certs/key.pem": Buffer.from("OLD-KEY"),
				"/tmp/test-relay/certs/cert.pem": Buffer.from("OLD-CERT"),
				"/ca/root/rootCA.pem": Buffer.from("CA"),
			});

			const exec = vi.fn((cmd: string): string => {
				execCalls.push(cmd);
				if (cmd === "mkcert -CAROOT") return "/ca/root\n";
				if (cmd.startsWith("openssl x509")) {
					// Cert only has 192.168.1.50, not 10.0.0.99 (new IP)
					return "Subject Alternative Name: IP Address:192.168.1.50";
				}
				if (cmd.startsWith("mkcert -key-file")) {
					// Simulate mkcert writing new certs
					const read = mockFs.readFileSync as unknown as ReturnType<
						typeof vi.fn
					>;
					read.mockImplementation((p: string) => {
						if (typeof p === "string" && p.endsWith("key.pem"))
							return Buffer.from("NEW-KEY");
						if (typeof p === "string" && p.endsWith("cert.pem"))
							return Buffer.from("NEW-CERT");
						if (typeof p === "string" && p.endsWith("rootCA.pem"))
							return Buffer.from("CA");
						throw new Error("ENOENT");
					});
					return "regenerated certs";
				}
				return "";
			});

			const ni = mockNetworkInterfaces({
				eth0: [makeIPv4("192.168.1.50")],
				wlan0: [makeIPv4("10.0.0.99")],
			});

			const result = await ensureCerts({
				exec,
				fs: mockFs,
				networkInterfaces: ni,
				configDir: "/tmp/test-relay",
			});

			expect(result).not.toBeNull();
			// Verify mkcert was called to regenerate
			const mkcertCall = execCalls.find((c) =>
				c.startsWith("mkcert -key-file"),
			);
			expect(mkcertCall).toBeDefined();
			expect(mkcertCall).toContain("10.0.0.99");
		});

		it("T29: creates certs directory if missing", async () => {
			const mockFs = createMockFs({});
			const exec = vi.fn((cmd: string): string => {
				if (cmd === "mkcert -CAROOT") return "/ca/root\n";
				if (cmd.startsWith("mkcert -key-file")) {
					// Simulate mkcert writing certs
					const read = mockFs.readFileSync as unknown as ReturnType<
						typeof vi.fn
					>;
					read.mockImplementation((p: string) => {
						if (typeof p === "string" && p.endsWith("key.pem"))
							return Buffer.from("K");
						if (typeof p === "string" && p.endsWith("cert.pem"))
							return Buffer.from("C");
						throw new Error("ENOENT");
					});
					return "ok";
				}
				return "";
			});

			const ni = mockNetworkInterfaces({
				eth0: [makeIPv4("192.168.1.1")],
			});

			await ensureCerts({
				exec,
				fs: mockFs,
				networkInterfaces: ni,
				configDir: "/tmp/test-relay",
			});

			expect(mockFs.mkdirSync).toHaveBeenCalledWith("/tmp/test-relay/certs", {
				recursive: true,
			});
		});

		it("T30: returns correct TlsCerts shape", async () => {
			const mockFs = createMockFs({
				"/tmp/test-relay/certs/key.pem": Buffer.from("KEY-DATA"),
				"/tmp/test-relay/certs/cert.pem": Buffer.from("CERT-DATA"),
				"/ca/root/rootCA.pem": Buffer.from("ROOT-CA"),
			});

			const exec = vi.fn((cmd: string): string => {
				if (cmd === "mkcert -CAROOT") return "/ca/root\n";
				if (cmd.startsWith("openssl x509")) {
					return "Subject Alternative Name: IP Address:192.168.1.50";
				}
				return "";
			});

			const ni = mockNetworkInterfaces({
				eth0: [makeIPv4("192.168.1.50")],
			});

			const result = await ensureCerts({
				exec,
				fs: mockFs,
				networkInterfaces: ni,
				configDir: "/tmp/test-relay",
			});

			expect(result).not.toBeNull();
			expect(result).toHaveProperty("key");
			expect(result).toHaveProperty("cert");
			expect(result).toHaveProperty("caRoot");
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(Buffer.isBuffer(result!.key)).toBe(true);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(Buffer.isBuffer(result!.cert)).toBe(true);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(result!.caRoot).toBe("/ca/root/rootCA.pem");
		});

		it("T31: handles mkcert generation failure gracefully", async () => {
			const mockFs = createMockFs({});
			const exec = vi.fn((cmd: string): string => {
				if (cmd === "mkcert -CAROOT") return "/ca/root\n";
				if (cmd.startsWith("mkcert -key-file")) {
					throw new Error("mkcert failed");
				}
				return "";
			});

			const ni = mockNetworkInterfaces({
				eth0: [makeIPv4("192.168.1.1")],
			});

			const result = await ensureCerts({
				exec,
				fs: mockFs,
				networkInterfaces: ni,
				configDir: "/tmp/test-relay",
			});

			expect(result).toBeNull();
		});

		it("T32: includes all IPs + localhost in cert generation command", async () => {
			const execCalls: string[] = [];
			const mockFs = createMockFs({});

			const exec = vi.fn((cmd: string): string => {
				execCalls.push(cmd);
				if (cmd === "mkcert -CAROOT") return "/ca/root\n";
				if (cmd.startsWith("mkcert -key-file")) {
					const read = mockFs.readFileSync as unknown as ReturnType<
						typeof vi.fn
					>;
					read.mockImplementation((p: string) => {
						if (typeof p === "string" && p.endsWith("key.pem"))
							return Buffer.from("K");
						if (typeof p === "string" && p.endsWith("cert.pem"))
							return Buffer.from("C");
						throw new Error("ENOENT");
					});
					return "ok";
				}
				return "";
			});

			const ni = mockNetworkInterfaces({
				eth0: [makeIPv4("192.168.1.50")],
				tailscale0: [makeIPv4("100.100.1.1")],
			});

			await ensureCerts({
				exec,
				fs: mockFs,
				networkInterfaces: ni,
				configDir: "/tmp/test-relay",
			});

			const mkcertCall = execCalls.find((c) =>
				c.startsWith("mkcert -key-file"),
			);
			expect(mkcertCall).toBeDefined();
			// Must include localhost, 127.0.0.1, ::1, and all IPs
			expect(mkcertCall).toContain("localhost");
			expect(mkcertCall).toContain("127.0.0.1");
			expect(mkcertCall).toContain("::1");
			expect(mkcertCall).toContain("192.168.1.50");
			expect(mkcertCall).toContain("100.100.1.1");
		});
	});
});
