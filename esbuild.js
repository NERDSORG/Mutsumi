const esbuild = require("esbuild");
const path = require("path");

/**
 * @moonshot-ai/kosong sources import package-internal modules via the
 * package.json "imports" map ("#/*" -> "./src/*.ts"). esbuild rejects
 * "#/" specifiers (stricter than Node/TypeScript here), so route them to
 * the package's src tree explicitly. Only applies to files inside kosong;
 * every other importer's "#" imports are left untouched.
 * @type {import('esbuild').Plugin}
 */
const kosongImportsPlugin = {
	name: "kosong-imports",
	setup(build) {
		const kosongSrc = path.join(
			__dirname,
			"node_modules",
			"@moonshot-ai",
			"kosong",
			"src",
		);
		const kosongMarker = path.join("@moonshot-ai", "kosong") + path.sep;
		build.onResolve({ filter: /^#\// }, (args) => {
			if (!args.importer.includes(kosongMarker)) return undefined;
			return { path: path.join(kosongSrc, args.path.slice(2) + ".ts") };
		});
	},
};

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

async function main() {
	// === Extension build (Node.js, CJS) ===
	const extCtx = await esbuild.context({
		entryPoints: ["src/extension.ts"],
		bundle: true,
		format: "cjs",
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: "node",
		outfile: "dist/extension.js",
		external: [
			"vscode",
			"better-sqlite3",
			"sqlite-vec",
			"web-tree-sitter",
			"node-notifier",
		],
		logLevel: "warning",
		plugins: [
			kosongImportsPlugin,
			/* add to the end of plugins array */
			esbuildProblemMatcherPlugin,
		],
	});

	// === Renderer build (Browser, ESM) ===
	// VS Code loads notebook renderers via import() in the webview,
	// so the entrypoint must be an ES module. CJS output would crash
	// at load time with "module is not defined".
	const rendererCtx = await esbuild.context({
		entryPoints: ["src/notebook/renderer.ts"],
		bundle: true,
		format: "esm",
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: "browser",
		outfile: "dist/notebookRenderer.js",
		external: [],
		logLevel: "warning",
		plugins: [
			esbuildProblemMatcherPlugin,
		],
	});

	if (watch) {
		await extCtx.watch();
		await rendererCtx.watch();
	} else {
		await extCtx.rebuild();
		await rendererCtx.rebuild();
		await extCtx.dispose();
		await rendererCtx.dispose();
	}
}

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: "esbuild-problem-matcher",

	setup(build) {
		build.onStart(() => {
			console.log("[watch] build started");
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				if (location == null) return;
				console.error(
					`    ${location.file}:${location.line}:${location.column}:`,
				);
			});
			console.log("[watch] build finished");
		});
	},
};

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
