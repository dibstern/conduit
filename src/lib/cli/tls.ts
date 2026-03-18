// ─── TLS Certificate Management (Ticket 8.2) ────────────────────────────────
// Manages mkcert-based TLS certificates for HTTPS access over LAN/Tailscale.
// All system calls (exec, fs, networkInterfaces) are injectable for testing.

import { execSync as defaultExecSync } from "node:child_process";
import * as defaultFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { DEFAULT_CONFIG_DIR } from "../env.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TlsCerts {
	key: Buffer;
	cert: Buffer;
	caRoot: string | null;
}

export interface TlsFs {
	readFileSync: typeof defaultFs.readFileSync;
	existsSync: typeof defaultFs.existsSync;
	mkdirSync: typeof defaultFs.mkdirSync;
}

export interface TlsOptions {
	/** Config directory — defaults to ~/.opencode-relay */
	configDir?: string;
	/** Injectable execSync for testing */
	exec?: (cmd: string) => string;
	/** Injectable networkInterfaces for testing */
	networkInterfaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
	/** Injectable fs for testing */
	fs?: TlsFs;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

function defaultExec(cmd: string): string {
	return defaultExecSync(cmd, { encoding: "utf8", stdio: "pipe" });
}

// ─── isRoutableIP ────────────────────────────────────────────────────────────

/**
 * Returns true if the address is in a private or CGNAT range:
 * - 10.x.x.x (Class A private)
 * - 192.168.x.x (Class C private)
 * - 172.16.0.0 – 172.31.255.255 (Class B private)
 * - 100.64.0.0 – 100.127.255.255 (CGNAT / Tailscale)
 */
export function isRoutableIP(addr: string): boolean {
	if (addr.startsWith("10.")) return true;
	if (addr.startsWith("192.168.")) return true;

	if (addr.startsWith("172.")) {
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		const second = Number.parseInt(addr.split(".")[1]!, 10);
		return second >= 16 && second <= 31;
	}

	if (addr.startsWith("100.")) {
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		const second = Number.parseInt(addr.split(".")[1]!, 10);
		return second >= 64 && second <= 127;
	}

	return false;
}

// ─── getAllIPs ────────────────────────────────────────────────────────────────

/**
 * Collect all routable IPv4 addresses from network interfaces.
 * Filters out internal/loopback and non-routable addresses.
 */
export function getAllIPs(
	opts?: Pick<TlsOptions, "networkInterfaces">,
): string[] {
	const getInterfaces = opts?.networkInterfaces ?? os.networkInterfaces;
	const ifaces = getInterfaces();
	const ips: string[] = [];

	for (const addrs of Object.values(ifaces)) {
		if (!addrs) continue;
		for (const addr of addrs) {
			if (
				addr.family === "IPv4" &&
				!addr.internal &&
				isRoutableIP(addr.address)
			) {
				ips.push(addr.address);
			}
		}
	}

	return ips;
}

// ─── getTailscaleIP ──────────────────────────────────────────────────────────

/**
 * Get the Tailscale IP address. Prefers tailscale0/utun interfaces,
 * falls back to any 100.x address in the CGNAT range.
 */
export function getTailscaleIP(
	opts?: Pick<TlsOptions, "networkInterfaces">,
): string | null {
	const getInterfaces = opts?.networkInterfaces ?? os.networkInterfaces;
	const ifaces = getInterfaces();

	// First pass: prefer tailscale0 / utun interfaces
	for (const [name, addrs] of Object.entries(ifaces)) {
		if (!addrs) continue;
		if (/^(tailscale|utun)/.test(name)) {
			for (const addr of addrs) {
				if (
					addr.family === "IPv4" &&
					!addr.internal &&
					addr.address.startsWith("100.")
				) {
					return addr.address;
				}
			}
		}
	}

	// Second pass: fall back to any 100.x address
	for (const addrs of Object.values(ifaces)) {
		if (!addrs) continue;
		for (const addr of addrs) {
			if (
				addr.family === "IPv4" &&
				!addr.internal &&
				addr.address.startsWith("100.")
			) {
				return addr.address;
			}
		}
	}

	return null;
}

// ─── hasTailscale ────────────────────────────────────────────────────────────

/** Returns true if a Tailscale IP is detected */
export function hasTailscale(
	opts?: Pick<TlsOptions, "networkInterfaces">,
): boolean {
	return getTailscaleIP(opts) !== null;
}

// ─── hasMkcert ───────────────────────────────────────────────────────────────

/** Returns true if mkcert is installed and its CA root is accessible */
export function hasMkcert(opts?: Pick<TlsOptions, "exec">): boolean {
	const exec = opts?.exec ?? defaultExec;
	try {
		exec("mkcert -CAROOT");
		return true;
	} catch {
		return false;
	}
}

// ─── getMkcertCaRoot ─────────────────────────────────────────────────────────

/** Get the mkcert CA root path, or null if mkcert is not available */
export function getMkcertCaRoot(
	opts?: Pick<TlsOptions, "exec">,
): string | null {
	const exec = opts?.exec ?? defaultExec;
	try {
		return exec("mkcert -CAROOT").trim();
	} catch {
		return null;
	}
}

// ─── ensureCerts ─────────────────────────────────────────────────────────────

/**
 * Main TLS certificate management function.
 *
 * 1. Checks ~/.opencode-relay/certs/ for existing key.pem + cert.pem.
 * 2. If certs exist and all current IPs are covered, returns them.
 * 3. If certs exist but IPs changed and mkcert is available, regenerates.
 * 4. If certs exist but IPs changed and mkcert is NOT available, returns
 *    existing certs as-is (stale certs are better than falling back to HTTP).
 * 5. If no certs exist and mkcert is available, generates new ones.
 * 6. If no certs exist and mkcert is NOT available, returns null.
 * 7. CA root: prefers mkcert's CAROOT, falls back to certDir/rootCA.pem.
 */
export async function ensureCerts(opts?: TlsOptions): Promise<TlsCerts | null> {
	const exec = opts?.exec ?? defaultExec;
	const fs = opts?.fs ?? defaultFs;
	const configDir = opts?.configDir ?? DEFAULT_CONFIG_DIR;

	const mkcertInstalled = hasMkcert({ exec });

	const certDir = path.join(configDir, "certs");
	const keyPath = path.join(certDir, "key.pem");
	const certPath = path.join(certDir, "cert.pem");

	// Resolve CA root path: prefer mkcert's CAROOT, fall back to local rootCA.pem
	let caRoot: string | null = null;
	if (mkcertInstalled) {
		try {
			const caRootDir = exec("mkcert -CAROOT").trim();
			const caRootPath = path.join(caRootDir, "rootCA.pem");
			if (fs.existsSync(caRootPath)) {
				caRoot = caRootPath;
			}
		} catch {
			// CA root not found via mkcert — continue
		}
	}
	if (!caRoot) {
		const localCaPath = path.join(certDir, "rootCA.pem");
		if (fs.existsSync(localCaPath)) {
			caRoot = localCaPath;
		}
	}

	// Collect all routable IPs
	const allIPs = getAllIPs({
		...(opts?.networkInterfaces != null && {
			networkInterfaces: opts.networkInterfaces,
		}),
	});

	// Check for existing certs
	if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
		let needRegen = false;
		try {
			const certText = exec(`openssl x509 -in ${certPath} -text -noout`);
			for (const ip of allIPs) {
				if (!certText.includes(ip)) {
					needRegen = true;
					break;
				}
			}
		} catch {
			needRegen = true;
		}

		if (!needRegen) {
			return {
				key: Buffer.from(fs.readFileSync(keyPath)),
				cert: Buffer.from(fs.readFileSync(certPath)),
				caRoot,
			};
		}

		// Certs exist but need regeneration — without mkcert, return existing
		// certs as-is (stale certs covering fewer IPs > falling back to HTTP)
		if (!mkcertInstalled) {
			return {
				key: Buffer.from(fs.readFileSync(keyPath)),
				cert: Buffer.from(fs.readFileSync(certPath)),
				caRoot,
			};
		}
	}

	// No existing certs — need mkcert to generate new ones
	if (!mkcertInstalled) {
		return null;
	}

	// Create certs directory if missing
	fs.mkdirSync(certDir, { recursive: true });

	// Build domain list
	const domains = ["localhost", "127.0.0.1", "::1"];
	for (const ip of allIPs) {
		if (!domains.includes(ip)) {
			domains.push(ip);
		}
	}

	// Generate certificates with mkcert
	try {
		const args = ["-key-file", keyPath, "-cert-file", certPath, ...domains];
		exec(`mkcert ${args.join(" ")}`);
	} catch {
		return null;
	}

	// Read and return the generated certs
	try {
		return {
			key: Buffer.from(fs.readFileSync(keyPath)),
			cert: Buffer.from(fs.readFileSync(certPath)),
			caRoot,
		};
	} catch {
		return null;
	}
}
