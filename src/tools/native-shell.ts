import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { assertSecurityCoverage } from "./_helpers";

// All three tools below shell out to dforge-cli. Prefer an explicit native
// binary override, then the dforge-cli package bundled with this MCP package,
// then PATH lookup for globally installed CLIs.

type CliCommand = { bin: string; argsPrefix: string[]; display: string };

const require = createRequire(__filename);

function needsWindowsCommandShell(bin: string): boolean {
	if (process.platform !== "win32") return false;
	// `.cmd` / `.bat` shims can only be launched through cmd.exe. A bare command
	// name (no path separator) also needs the shell so PATHEXT resolves the
	// `.cmd` / `.exe` that `npm install -g` drops on PATH — spawnSync without a
	// shell only matches an exact file and would ENOENT on the shim.
	if (/\.(?:cmd|bat)$/i.test(bin)) return true;
	return !bin.includes("\\") && !bin.includes("/");
}

// Quote one token for a Windows command line. shell:true performs NO escaping,
// so a path with spaces would split into multiple args and a metacharacter
// (`&`, `|`, `>`, …) would inject a second command. Wrapping in double quotes
// makes those literal to cmd.exe; backslash/quote runs are doubled per the
// CommandLineToArgvW rules so the target program parses the value intact.
function quoteWinArg(arg: string): string {
	if (arg.length > 0 && !/[\s"&|<>^()%!]/.test(arg)) {
		return arg;
	}
	let quoted = '"';
	let backslashes = 0;
	for (const ch of arg) {
		if (ch === "\\") {
			backslashes++;
			continue;
		}
		if (ch === '"') {
			quoted += "\\".repeat(backslashes * 2 + 1) + '"';
		} else {
			quoted += "\\".repeat(backslashes) + ch;
		}
		backslashes = 0;
	}
	quoted += "\\".repeat(backslashes * 2) + '"';
	return quoted;
}

// Single entry point for invoking the resolved CLI. On Windows shim/PATH cases
// it builds a fully-quoted command line and runs it through the shell; every
// other case (bundled `node <cli>`, a native binary, macOS/Linux) spawns
// directly with shell:false.
function spawnCli(
	cli: CliCommand,
	args: string[],
	options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
	const fullArgs = [...cli.argsPrefix, ...args];
	if (needsWindowsCommandShell(cli.bin)) {
		const commandLine = [cli.bin, ...fullArgs].map(quoteWinArg).join(" ");
		return spawnSync(commandLine, { encoding: "utf8", shell: true, ...options });
	}
	return spawnSync(cli.bin, fullArgs, { encoding: "utf8", shell: false, ...options });
}

function resolveDforgeCli(): CliCommand {
	const override = process.env.DFORGE_CLI_BINARY;
	if (override) {
		if (!fs.existsSync(override)) {
			throw new Error(
				`DFORGE_CLI_BINARY points at non-existent path: ${override}`,
			);
		}
		return { bin: override, argsPrefix: [], display: override };
	}
	try {
		const cliEntry = require.resolve("@dforge-core/dforge-cli");
		return {
			bin: process.execPath,
			argsPrefix: [cliEntry],
			display: `node ${cliEntry}`,
		};
	} catch {
		// Fall through to PATH lookup below.
	}
	return { bin: "dforge-cli", argsPrefix: [], display: "dforge-cli" };
}

function run(args: string[], cwd?: string): { stdout: string; stderr: string; code: number; command: string } {
	const cli = resolveDforgeCli();
	const r = spawnCli(cli, args, { cwd });
	if (r.error) {
		throw new Error(
			`Failed to exec ${cli.display}: ${r.error.message}. ` +
				`Install with: npm install -g @dforge-core/dforge-cli (or set DFORGE_CLI_BINARY=/path/to/binary).`,
		);
	}
	return {
		stdout: r.stdout ?? "",
		stderr: r.stderr ?? "",
		code: r.status ?? 1,
		command: [cli.display, ...args].join(" "),
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

	// Strip wrapping punctuation a freeform log line may add around the path
	// (e.g. quotes, parens, a trailing comma/period) before resolving.
	const clean = (s: string) => s.replace(/^[\s'"([{<]+/, "").replace(/[\s'"),.;:\]}>]+$/, "");
	// One stat per path: file size if it's an existing regular file, else undefined.
	const fileSize = (p: string): number | undefined => {
		try {
			const st = fs.statSync(p);
			return st.isFile() ? st.size : undefined;
		} catch {
			return undefined;
		}
	};

	let tarballPath = "";
	let sizeBytes = 0;
	for (const c of candidates) {
		const resolved = path.resolve(clean(c));
		const size = fileSize(resolved);
		if (size !== undefined) {
			tarballPath = resolved;
			sizeBytes = size;
			break;
		}
	}
	// Nothing on disk matched — surface the best-guess path anyway.
	if (!tarballPath && candidates.length) tarballPath = path.resolve(clean(candidates[0]));
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
): { ok: boolean; exitCode: number; command: string; output: string } {
	const argList = ["module", "install", "--path", args.pathOrTarball];
	if (args.tenantCode) {
		argList.push("--code", args.tenantCode);
	}
	const env: Record<string, string> = {};
	if (args.tenantUrl) env.DFORGE_URL = args.tenantUrl;
	if (args.token) env.DFORGE_TOKEN = args.token;

	const cli = resolveDforgeCli();
	const r = spawnCli(cli, argList, { env: { ...process.env, ...env } });
	if (r.error) {
		throw new Error(`Failed to exec ${cli.display}: ${r.error.message}`);
	}
	const ok = r.status === 0;
	const output = (r.stdout ?? "") + (r.stderr ?? "");
	return {
		ok,
		exitCode: r.status ?? 1,
		command: [cli.display, ...argList].join(" "),
		output,
	};
}
