import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// HARD CONSTRAINT: the deployed artifact must be ONE self-contained, UNMINIFIED
// index.html so it boots under the v2 CSP (script-src 'unsafe-inline', no 'self')
// and stays human-auditable. viteSingleFile inlines all JS/CSS; minify:false +
// inlineDynamicImports + modulePreload:false guarantee no external <script src>
// / <link> / modulepreload ever reaches the output. Verified by tools/verify-single-file.mjs.
export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
  build: {
    outDir: '../v3',
    emptyOutDir: true,
    minify: false,
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    modulePreload: false,
    target: 'es2022',
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
  },
});
