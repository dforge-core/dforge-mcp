#!/usr/bin/env node
// Copy the JSON schemas from the installed @dforge-core/metadata package into
// resources/schemas/, where they're served as MCP resources (dforge://schema/*)
// and shipped in the npm tarball (jsdelivr serves them from there).
//
// Cross-platform (pure Node — runs on Windows/macOS/Linux) and wired into
// `prepublishOnly`, so every publish regenerates the schemas from the exact
// metadata version this package depends on. That's what keeps the vendored
// copies from drifting: bump @dforge-core/metadata, publish, done.
//
// metadata ships snake_case filenames (data_views, seed_data, print_templates);
// mcp's public URLs use kebab-case (data-views, seed-data, print-templates) —
// editor settings emitted by dforge-cli point at those kebab names — so we
// rename `_` -> `-` on copy.

const fs = require("node:fs");
const path = require("node:path");

const OUT_DIR = path.resolve(__dirname, "..", "resources", "schemas");

let pkgJson;
try {
	pkgJson = require.resolve("@dforge-core/metadata/package.json");
} catch {
	console.error("Can't find @dforge-core/metadata — run `pnpm install` first.");
	process.exit(1);
}

// Vendoring from a stale install ships the old schemas under a newer dependency range.
// Caret/tilde/exact ranges only; anything else is left to the package manager.
{
	const installed = require(pkgJson).version;
	const range = require("../package.json").dependencies["@dforge-core/metadata"];
	const m = /^([\^~]?)(\d+)\.(\d+)\.(\d+)$/.exec(range);
	const v = /^(\d+)\.(\d+)\.(\d+)/.exec(installed);
	if (m && v) {
		const [, op, ...want] = m;
		const have = v.slice(1);
		const [wM, wm, wp] = want.map(Number);
		const [hM, hm, hp] = have.map(Number);
		const ge = hM > wM || (hM === wM && (hm > wm || (hm === wm && hp >= wp)));
		const sameLine =
			op === "~" ? hM === wM && hm === wm
			: op === "^" ? (wM > 0 ? hM === wM : wm > 0 ? hM === 0 && hm === wm : hM === 0 && hm === 0 && hp === wp)
			: hM === wM && hm === wm && hp === wp;
		if (!ge || !sameLine) {
			console.error(
				`Installed @dforge-core/metadata ${installed} does not satisfy package.json (${range}) — run \`pnpm install\` before vendoring.`,
			);
			process.exit(1);
		}
	}
}

const SRC_DIR = path.join(path.dirname(pkgJson), "schemas");
if (!fs.existsSync(SRC_DIR)) {
	console.error(`@dforge-core/metadata has no schemas/ dir — installed version too old.`);
	process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

// Clear stale schema files first so a renamed/removed upstream schema doesn't
// linger (only touches *.schema.json — never other files in resources/schemas/).
for (const f of fs.readdirSync(OUT_DIR)) {
	if (f.endsWith(".schema.json")) fs.rmSync(path.join(OUT_DIR, f));
}

const files = fs.readdirSync(SRC_DIR).filter((f) => f.endsWith(".schema.json"));
for (const f of files) {
	const dst = f.replace(/_/g, "-"); // snake_case -> kebab-case
	fs.copyFileSync(path.join(SRC_DIR, f), path.join(OUT_DIR, dst));
	console.log(`  ✓ schemas/${dst}`);
}
console.log(`Vendored ${files.length} schemas from @dforge-core/metadata into resources/schemas/.`);
