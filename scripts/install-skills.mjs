#!/usr/bin/env node
// Install the dForge authoring skills into the Claude skills directory.
//
// The skills ship inside the npm tarball, but Claude Code only looks in
// <config>/skills — not node_modules — so they have to be copied out. There are
// four (a router plus three stage skills), and the router's directory also
// carries the shared references/ + examples/ the MCP server serves as dforge://
// resources, so hand-copying is error-prone.
//
// Written in Node rather than bash so it behaves identically on Windows
// (cmd.exe, PowerShell), macOS, Linux, Git Bash and WSL. The bash version this
// replaced could not run in cmd/PowerShell at all, and under WSL it resolved
// $HOME to the LINUX home — silently installing to /home/you/.claude while
// Claude Code on Windows read C:\Users\you\.claude.
//
// Usage:
//   node scripts/install-skills.mjs              # from a local checkout
//   node scripts/install-skills.mjs --from-npm   # download the published version
//   DEST=/some/where node scripts/install-skills.mjs
//
//   npm run install-skills
//   npm run install-skills -- --from-npm

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const SKILLS = [
	["dforge-mcp-author", "router — start here; also holds the shared\n                        references/ and examples/ the MCP server serves"],
	["dforge-module-design", "Phase 0  — identity, intake, design, validation"],
	["dforge-module-build", "Phases 1-5 — entities, behavior, views, security"],
	["dforge-module-ship", "Phase 6  — validate, pack, install-fix loop"],
];

const PKG = "@dforge-core/dforge-mcp";
const fromNpm = process.argv.includes("--from-npm");

// Piping into `head`/`less` closes our stdout mid-write; without this Node
// turns that into an unhandled EPIPE and dumps a stack trace over what is
// otherwise a successful install.
for (const stream of [process.stdout, process.stderr]) {
	stream.on("error", (e) => {
		if (e.code === "EPIPE") process.exit(0);
		throw e;
	});
}

/**
 * Where Claude Code looks for skills. `CLAUDE_CONFIG_DIR` wins when set;
 * otherwise `<home>/.claude/skills`. os.homedir() is the point of this being a
 * Node script — on Windows it's %USERPROFILE% regardless of which shell (or
 * shell emulator) invoked us.
 */
function defaultDest() {
	if (process.env.DEST) return process.env.DEST;
	const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
	return path.join(configDir, "skills");
}

/** npm is a .cmd shim on Windows, which spawn can only launch through a shell. */
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

function npm(args, opts = {}) {
	const r = spawnSync(NPM, args, {
		encoding: "utf8",
		shell: process.platform === "win32",
		...opts,
	});
	if (r.error) {
		throw new Error(`Failed to run \`npm ${args.join(" ")}\`: ${r.error.message}. Is npm on your PATH?`);
	}
	if (r.status !== 0) {
		throw new Error(`\`npm ${args.join(" ")}\` failed (exit ${r.status}):\n${r.stderr || r.stdout}`);
	}
	return (r.stdout || "").trim();
}

/**
 * Download + unpack the published tarball into a temp dir, returning its
 * skills/ path. Uses `npm pack` (which fetches only this package, not its
 * ~35 MB native CLI dependency) plus `tar`, which ships with Windows 10 1803+,
 * macOS and every Linux.
 */
function fetchFromNpm(tmp) {
	// Resolve the real latest version rather than relying on a CDN alias that
	// caches for hours after a publish and would serve stale skills.
	const version = npm(["view", PKG, "version"]);
	process.stdout.write(`Fetching ${PKG}@${version} …\n`);
	npm(["pack", `${PKG}@${version}`, "--pack-destination", tmp], { cwd: tmp });

	const tarball = fs.readdirSync(tmp).find((f) => f.endsWith(".tgz"));
	if (!tarball) throw new Error(`npm pack produced no .tgz in ${tmp}`);

	const r = spawnSync("tar", ["-xzf", path.join(tmp, tarball), "-C", tmp], { encoding: "utf8" });
	if (r.error || r.status !== 0) {
		throw new Error(
			`Could not extract ${tarball}: ${r.error?.message ?? r.stderr}\n` +
				"`tar` is required (built into Windows 10 1803+, macOS and Linux). " +
				"Alternatively clone the repo and run this script without --from-npm.",
		);
	}
	return path.join(tmp, "package", "skills");
}

function main() {
	const dest = defaultDest();
	let tmp;
	let src;

	try {
		if (fromNpm) {
			tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dforge-skills-"));
			src = fetchFromNpm(tmp);
		} else {
			// Relative to this file, so it works from any cwd.
			const here = path.dirname(fileURLToPath(import.meta.url));
			src = path.join(here, "..", "skills");
		}

		if (!fs.existsSync(src)) {
			throw new Error(
				`No skills directory at ${src}.` +
					(fromNpm ? "" : " Run with --from-npm to install from the published package instead."),
			);
		}

		fs.mkdirSync(dest, { recursive: true });
		let installed = 0;
		for (const [skill] of SKILLS) {
			const from = path.join(src, skill);
			if (!fs.existsSync(from)) {
				process.stderr.write(`  ! skipping ${skill} (not found in ${src})\n`);
				continue;
			}
			// Replace wholesale: a stale reference file left behind is worse than a
			// missing one, because the agent will happily author against it.
			fs.rmSync(path.join(dest, skill), { recursive: true, force: true });
			fs.cpSync(from, path.join(dest, skill), { recursive: true });
			process.stdout.write(`  \u2713 ${skill}\n`);
			installed++;
		}

		if (installed === 0) throw new Error(`No skills were installed from ${src}.`);

		process.stdout.write(
			`\nInstalled ${installed} skill${installed === 1 ? "" : "s"} to ${dest}\n\n`,
		);
		for (const [skill, blurb] of SKILLS) {
			process.stdout.write(`  ${skill.padEnd(21)} ${blurb}\n`);
		}
		process.stdout.write(
			"\nRe-run after every dforge-mcp upgrade. The skill version is not checked at\n" +
				"runtime, so stale skills against new tools will misroute calls.\n",
		);
	} catch (e) {
		process.stderr.write(`error: ${e.message}\n`);
		process.exitCode = 1;
	} finally {
		if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
	}
}

main();
