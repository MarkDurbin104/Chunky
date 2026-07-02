/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  // The file-extract Web Worker dynamic-imports its heavy parsers
  // (mammoth, pdfjs, jszip, linkedom). Vite's default worker output
  // is IIFE, which rolls everything into one chunk and doesn't allow
  // code splitting — the production build fails with
  // `Invalid value "iife" for option "output.format"`. ES module
  // workers support code splitting and are supported in every
  // modern Chromium / Edge / Firefox; WebView2 (our runtime) covers
  // it.
  worker: {
    format: 'es',
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: false,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
  },
})
