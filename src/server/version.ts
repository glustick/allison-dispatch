import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'

// Reads the version from package.json relative to this module, which resolves correctly both
// under tsx (src/server/version.ts) and in the compiled build (dist/server/version.js) —
// '../..' lands on the project root from either location.
export function readAppVersion(): string {
  try {
    const raw = readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')
    const pkg = JSON.parse(raw) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0-dev'
  } catch {
    return '0.0.0-dev'
  }
}
