// A deliberate no-op service worker: its only job is installability (some browsers still
// want one registered before offering "Install app"). It must NEVER cache — the app updates
// by redeploying and a cached bundle would pin viewers to stale assets and old API shapes.
self.addEventListener('fetch', () => {})
