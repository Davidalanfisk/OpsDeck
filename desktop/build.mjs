import { build } from 'esbuild';

await build({
  entryPoints: ['desktop/main.ts', 'desktop/preload.ts', 'desktop/smoke.ts', 'desktop/update-helper.ts'],
  outdir: 'desktop-dist',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  packages: 'external',
});
