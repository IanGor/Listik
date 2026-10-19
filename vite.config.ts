/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'

export default defineConfig({
  // GitHub Pages serves the app under /Listik/ (BASE in .github/workflows/pages.yml); locally it is /.
  base: process.env.BASE ?? '/',
  plugins: [solid()],
  test: {
    include: ['tests/**/*.test.ts'],
    // The model is DOM-free; vite-plugin-solid would default this to jsdom.
    environment: 'node',
  },
})
