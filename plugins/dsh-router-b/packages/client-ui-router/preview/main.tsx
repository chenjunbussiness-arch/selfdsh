/**
 * Preview page: the board and the workspace page side by side, on sample data,
 * in the theme the address asks for.
 *
 *   index.html               follows the system
 *   index.html?theme=light   day
 *   index.html?theme=dark    night
 *
 * Nothing here ships in the plugin; `scripts/build-preview.mjs` bundles it into
 * `preview/dist/` (ignored by git) for a browser or a headless screenshot.
 */

import { createRoot } from 'react-dom/client'
import { CompactBoard } from '../src/client/CompactBoard.tsx'
import { WorkspacePage } from '../src/client/WorkspacePage.tsx'
import { RouterBoardController } from '../src/client/controller.ts'
import { createMockSource } from '../src/client/mock.ts'
import { DICTIONARIES } from '../src/client/locales.ts'
import { THEME_STORAGE_KEY } from '../src/client/theme.tsx'

const params = new URLSearchParams(location.search)
const wanted = params.get('theme')
try {
  if (wanted === 'light' || wanted === 'dark' || wanted === 'auto') localStorage.setItem(THEME_STORAGE_KEY, wanted)
} catch {
  // Private window: the page still renders, following the system.
}
const lang = params.get('lang') === 'en' ? 'en' : 'zh'
const dict: Record<string, string> = DICTIONARIES[lang]
const t = (key: string, values: Record<string, string | number> = {}): string =>
  (dict[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? `{${name}}`))

const controller = new RouterBoardController(createMockSource())
void controller.load()

function App() {
  return (
    <div className="pv">
      <aside className="pv-board" data-preview="board"><CompactBoard controller={controller} t={t} /></aside>
      <main className="pv-ws" data-preview="workspace"><WorkspacePage controller={controller} t={t} /></main>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
