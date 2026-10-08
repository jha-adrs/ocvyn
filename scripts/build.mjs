// Bundles the extension, the engine worker and the webview with esbuild.
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const common = { bundle: true, sourcemap: true, logLevel: 'info', target: 'es2022' };
const builds = [
  { ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', external: ['vscode'] },
  { ...common, entryPoints: ['src/engine/worker.ts'], outfile: 'dist/worker.js', platform: 'node', format: 'cjs' },
  { ...common, entryPoints: ['webview/main.ts'], outfile: 'dist/webview.js', platform: 'browser', format: 'iife' },
];

if (watch) for (const b of builds) await (await esbuild.context(b)).watch();
else await Promise.all(builds.map(b => esbuild.build(b)));
