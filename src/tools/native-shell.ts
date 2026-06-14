import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { assertSecurityCoverage } from "./_helpers";

// All three tools below shell out to the native C# dforge-cli binary. They
// resolve the binary via DFORGE_CLI_BINARY env var or by trying the
// `dforge-cli` command on PATH. We deliberately don't try to require()
// @dforge-core/dforge-cli's sidecar packages — those have native binaries
// per platform that may not be installed alongside dforge-mcp.

function resolveDforgeCli(): string {
	const override = process.env.DFORGE_CLI_BINARY;
	if (override) {
		if (!fs.existsSync(override)) {
			throw new Error(
				`DFORGE_CLI_BINARY points at non-existent path: ${override}`,
			);
		}
		return override;
	}
	// Trust PATH lookup. dforge-cli installed via `npm install -g
	// @dforge-core/dforge-cli` exposes itself there.
	return "dforge-cli";
}

function run(args: string[], cwd?: string): { stdout: string; stderr: string; code: number } {
	const bin = resolveDforgeCli();
	const r = spawnSync(bin, args, {
		encoding: "utf8",
		cwd,
		shell: false,
	});
	if (r.error) {
		throw new Error(
			`Failed to exec ${bin}: ${r.error.message}. ` +
				`Install with: npm install -g @dforge-core/dforge-cli (or set DFORGE_CLI_BINARY=/path/to/binary).`,
		);
	}
	return {
		stdout: r.stdout ?? "",
		stderr: r.stderr ?? "",
		code: r.status ?? 1,
	};
}

// ─── pack ────────────────────────────────────────────────────────────

export const packModuleSchema = {
	moduleDir: z.string().describe("Path to module directory (containing manifest.json)."),
	outPath: z
		.string()
		.optional()
		.describe("Output file or directory. Defaults to cwd, naming the file <code>-<version>.dforge."),
};

export function packModule(
	args: z.infer<z.ZodObject<typeof packModuleSchema>>,
): { tarballPath: string; sizeBytes: number; output: string } {
	// Phase 5a gate — refuse to pack a module whose entities aren't covered by a
	// role (the platform won't catch this; the module would install inaccessible).
	const securityWarning = assertSecurityCoverage(args.moduleDir);
	const argList = ["module", "pack", args.moduleDir];
	if (args.outPath) {
		argList.push("-o", args.outPath);
	}
	const r = run(argList);
	if (r.code !== 0) {
		throw new Error(`pack failed (exit ${r.code}):\n${r.stderr || r.stdout}`);
	}
	// Resolve the tarball path. Parsing freeform stdout is inherently fragile, so
	// disambiguate by what's actually on disk — pack just wrote the file, so the
	// right candidate is the one that exists. Prefer an explicit output FILE;
	// then a quoted path (survives spaces); then every bare `*.dforge` token
	// (allowing Windows backslashes, which `\S` covers); finally the output dir.
	const candidates: string[] = [];
	if (args.outPath && args.outPath.toLowerCase().endsWith(".dforge")) {
		candidates.push(args.outPath);
	}
	const quoted = r.stdout.match(/["']([^"'\r\n]+\.dforge)["']/i);
	if (quoted) candidates.push(quoted[1]);
	for (const m of r.stdout.matchAll(/(\S+\.dforge)\b/gi)) candidates.push(m[1]);
	if (args.outPath) candidates.push(args.outPath); // dir fallback

	const resolved = candidates.map((c) => path.resolve(c));
	let sizeBytes = 0;
	let tarballPath = resolved.find((p) => fs.existsSync(p) && fs.statSync(p).isFile()) ?? resolved[0] ?? "";
	if (tarballPath && fs.existsSync(tarballPath) && fs.statSync(tarballPath).isFile()) {
		sizeBytes = fs.statSync(tarballPath).size;
	}
	const output = securityWarning ? `${securityWarning}\n\n${r.stdout}` : r.stdout;
	return { tarballPath, sizeBytes, output };
}

// ─── install ─────────────────────────────────────────────────────────

export const installModuleSchema = {
	pathOrTarball: z
		.string()
		.describe("Module directory OR path to a .dforge tarball."),
	tenantUrl: z
		.string()
		.url()
		.optional()
		.describe("Tenant URL. Falls back to DFORGE_URL env var."),
	token: z
		.string()
		.optional()
		.describe("Auth token. Falls back to DFORGE_TOKEN env var."),
	tenantCode: z
		.string()
		.optional()
		.describe("Optional --code sanity check; server rejects if token's tenant doesn't match."),
};

export function installModule(
	args: z.infer<z.ZodObject<typeof installModuleSchema>>,
): { ok: boolean; output: string } {
	const argList = ["module", "install", "--path", args.pathOrTarball];
	if (args.tenantCode) {
		argList.push("--code", args.tenantCode);
	}
	const env: Record<string, string> = {};
	if (args.tenantUrl) env.DFORGE_URL = args.tenantUrl;
	if (args.token) env.DFORGE_TOKEN = args.token;

	const bin = resolveDforgeCli();
	const r = spawnSync(bin, argList, {
		encoding: "utf8",
		env: { ...process.env, ...env },
		shell: false,
	});
	if (r.error) {
		throw new Error(`Failed to exec ${bin}: ${r.error.message}`);
	}
	const ok = r.status === 0;
	const output = (r.stdout ?? "") + (r.stderr ?? "");
	return { ok, output };
}
