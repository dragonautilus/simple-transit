import { defineConfig } from 'vite'

export default defineConfig({
  // Relative asset paths: the packaged .ehpk is not served from a web root
  base: './',
  build: { target: 'es2022' },
})
