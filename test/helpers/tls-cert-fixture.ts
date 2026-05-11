import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TlsCerts } from "../../src/lib/cli/tls.js";

export function makeTestTlsCerts(): TlsCerts {
	const dir = mkdtempSync(join(tmpdir(), "conduit-test-tls-"));
	const keyPath = join(dir, "key.pem");
	const certPath = join(dir, "cert.pem");

	try {
		execFileSync(
			"openssl",
			[
				"req",
				"-x509",
				"-newkey",
				"rsa:2048",
				"-keyout",
				keyPath,
				"-out",
				certPath,
				"-days",
				"1",
				"-nodes",
				"-subj",
				"/CN=localhost",
			],
			{ stdio: "ignore" },
		);

		return {
			key: readFileSync(keyPath),
			cert: readFileSync(certPath),
			caRoot: null,
			caCertPem: null,
			caCertDer: null,
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
