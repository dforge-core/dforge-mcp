import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// @dforge-core/metadata's published dist uses extensionless ESM relative
		// imports (e.g. `import "./aggregation"`), which only a bundler resolves —
		// plain Node ESM throws ERR_MODULE_NOT_FOUND. Inline it so Vite transforms
		// it for the test run. The server bundles it via tsup at build time, so
		// runtime is unaffected; this is only for vitest's Node loader.
		//
		// Key path: `test.server.deps.inline` is correct for Vitest 1.0+ (verified
		// on 3.2.6). The 0.x-era `test.deps.inline` is the deprecated alias. This
		// is self-checking: if the key stops applying (e.g. a future Vitest major
		// relocates it), the metadata-importing suites fail loudly with the
		// ERR_MODULE_NOT_FOUND above — not silently. The real root cause is
		// metadata's extensionless dist; fixing that build would remove the need.
		server: { deps: { inline: ["@dforge-core/metadata"] } },
	},
});
