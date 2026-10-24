import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.js'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('missing #root element')
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)

// Register the deliberate no-op service worker (see public/sw.js): installability without
// caching, so deploys always reach viewers.
if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js').catch(() => {
    // Registration failing (dev server, private mode) just means no install prompt.
  })
}
