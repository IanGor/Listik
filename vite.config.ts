/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'

export default defineConfig({
  plugins: [solid()],
  test: {
    include: ['tests/**/*.test.ts'],
    // The model is DOM-free; vite-plugin-solid would default this to jsdom.
    environment: 'node',
  },
})
