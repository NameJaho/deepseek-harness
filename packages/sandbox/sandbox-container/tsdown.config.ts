import { defineConfig } from 'tsdown'

/** Keep the image-side runner self-contained so it uses only the image's Node runtime. */
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/runner-entry.js'], outDir: 'lib', format: ['esm'],
  platform: 'node', target: 'es2024', fixedExtension: false, dts: false, clean: false,
  noExternal: ['@deepseek-ai/dsh-subprocess/control'],
})
