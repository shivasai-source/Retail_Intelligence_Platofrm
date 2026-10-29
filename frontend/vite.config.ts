import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        // ONE BUNDLE WAS 1.1 MB, and every deploy re-sent all of it: a change
        // to a panel invalidated React and the router along with it. The
        // libraries change on their own schedule, so they are split out and
        // stay in the browser's cache across releases. Named by what they are,
        // not by `node_modules`, so a stray dependency does not silently join
        // the wrong chunk.
        // A function, not a map: this is Vite 8 on rolldown, where the object
        // form is not accepted.
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return
          if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) return 'react'
          if (/[\\/]node_modules[\\/](@tanstack|zustand)[\\/]/.test(id)) return 'query'
          if (/[\\/]node_modules[\\/]simple-icons[\\/]/.test(id)) return 'icons'
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      // The browser only ever talks to :5173 in dev — Vite forwards
      // anything under /api straight to FastAPI. Matches prod, where
      // FastAPI serves the built frontend and its own API from one origin.
      '/api': {
        target: 'http://127.0.0.1:8100',
        changeOrigin: true,
      },
    },
  },
})
