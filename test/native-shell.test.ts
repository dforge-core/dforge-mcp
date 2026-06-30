import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { installModule } from "../src/tools/native-shell";

const oldBinary = process.env.DFORGE_CLI_BINARY;
const oldCapture = process.env.DFORGE_TEST_CAPTURE;

afterEach(() => {
	if (oldBinary === undefined) delete process.env.DFORGE_CLI_BINARY;
	else process.env.DFORGE_CLI_BINARY = oldBinary;
	if (oldCapture === undefined) delete process.env.DFORGE_TEST_CAPTURE;
	else process.env.DFORGE_TEST_CAPTURE = oldCapture;
});

describe("dforge_module_install shell bridge", () => {
	it("returns raw CLI output and diagnostics when install fails", () => {
		const dir = mkdtempSync(join(tmpdir(), "dforge-mcp-cli-"));
		try {
			const capturePath = join(dir, "capture.json");
			const scriptPath = join(dir, "fake-cli.cjs");
			writeFileSync(
				scriptPath,
				[
					"const fs = require('node:fs');",
					"fs.writeFileSync(process.env.DFORGE_TEST_CAPTURE, JSON.stringify({",
					"  argv: process.argv.slice(2),",
					"  url: process.env.DFORGE_URL,",
					"  token: process.env.DFORGE_TOKEN",
					"}));",
					"console.log('HTTP 400 Bad Request');",
					"console.error('MODULE_INSTALL_ERROR: missing translation key menus.fin.items.invoice.label');",
					"process.exit(7);",
					"",
				].join("\n"),
			);

			const shimPath = process.platform === "win32" ? join(dir, "fake-cli.cmd") : join(dir, "fake-cli");
			writeFileSync(
				shimPath,
				process.platform === "win32"
					? `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`
					: `#!/usr/bin/env sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`,
			);
			chmodSync(shimPath, 0o755);

			process.env.DFORGE_CLI_BINARY = shimPath;
			process.env.DFORGE_TEST_CAPTURE = capturePath;

			const result = installModule({
				pathOrTarball: "/tmp/bad-module.dforge",
				tenantUrl: "http://localhost:5001",
				token: "test-token",
				tenantCode: "demo",
			});

			expect(result.ok).toBe(false);
			expect(result.exitCode).toBe(7);
			expect(result.command).toContain("module install --path /tmp/bad-module.dforge --code demo");
			expect(result.output).toContain("HTTP 400 Bad Request");
			expect(result.output).toContain("MODULE_INSTALL_ERROR: missing translation key");

			const captured = JSON.parse(readFileSync(capturePath, "utf8"));
			expect(captured.argv).toEqual([
				"module",
				"install",
				"--path",
				"/tmp/bad-module.dforge",
				"--code",
				"demo",
			]);
			expect(captured.url).toBe("http://localhost:5001");
			expect(captured.token).toBe("test-token");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
