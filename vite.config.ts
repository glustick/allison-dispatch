import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Same split as the sibling app: the client is a separate Vite project (root src/client)
// while the server is plain tsc (tsconfig.json). The build emits into public/, which
// src/server/app.ts serves as static files with an SPA fallback — no server changes needed.
//
// Dev playback note: the browser plays Dispatcharr's /proxy/ts/stream/ URLs DIRECTLY (its
// CORS is wide open), so unlike the sibling there is deliberately no stream-path proxy here —
// only /api goes to the BFF.
export default defineConfig({
  root: 'src/client',
  plugins: [react()],
  build: {
    outDir: '../../public',
    emptyOutDir: true
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8086'
    }
  }
})
