// Capture (M15) — the PO's friction-free intake. Both surfaces (modal,
// quick-add row) and the palette write through ONE helper and the existing
// `item:save` create path: no new IPC channel, no second write path.
import { useState } from 'react'
import type { Item } from '../../preload/index'
import { MicButton } from './chatShared'
import {
  appendText,
  BTN_GHOST,
  BTN_PRIMARY,
  INPUT,
  LABEL,
  paletteResults,
  saveCapture,
  TEXTAREA,
  type PaletteResult
} from './ui'

// Prose, not code: the shared TEXTAREA is mono, so the font is overridden here.
const PROSE = `${TEXTAREA} font-body-md`
const OVERLAY = 'fixed inset-0 z-30 flex items-start justify-center bg-black/50 p-16'
const PANEL =
  'w-full max-w-[480px] rounded-xl border border-border-subtle bg-surface-elevated p-card-padding flex flex-col gap-3'

export function CaptureModal({
  repo,
  onClose,
  onGroom,
  onSaved
}: {
  repo: string
  onClose: () => void
  onGroom: (item: Item) => void
  onSaved: () => void
}): React.JSX.Element {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  // Enter saves and the modal STAYS OPEN with a cleared, refocused field — three
  // Enters produce three Backlog cards in order. The card appearing is the
  // confirmation; the app never toasts.
  const add = async (): Promise<Item | null> => {
    if (busy) return null
    setBusy(true)
    const saved = await saveCapture(repo, text)
    setBusy(false)
    if (!saved) return null
    setText('')
    onSaved()
    return saved
  }

  const groomNow = async (): Promise<void> => {
    const saved = await add()
    if (saved) onGroom(saved)
  }

  return (
    <div className={OVERLAY} onMouseDown={onClose}>
      <div className={PANEL} onMouseDown={(e) => e.stopPropagation()}>
        <span className={LABEL}>New idea</span>
        <textarea
          autoFocus
          rows={4}
          className={PROSE}
          placeholder="What's on your mind?"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void add()
            }
          }}
        />
        <div className="flex items-center justify-between gap-2">
          <MicButton onText={(t) => setText((c) => appendText(c, t))} />
          <div className="flex items-center gap-2">
            <button className={BTN_GHOST} disabled={busy} onClick={() => void groomNow()}>
              Groom now →
            </button>
            <button className={BTN_PRIMARY} disabled={busy} onClick={() => void add()}>
              Add to Backlog
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** The inline quick-add row pinned atop the Backlog column — same write path. */
export function QuickAdd({
  repo,
  refresh
}: {
  repo: string
  refresh: () => void
}): React.JSX.Element {
  const [text, setText] = useState('')
  const [open, setOpen] = useState(false)

  const submit = async (): Promise<void> => {
    const saved = await saveCapture(repo, text)
    if (!saved) return
    setText('')
    refresh()
  }

  return (
    <div className="mb-2 flex flex-col gap-2">
      <textarea
        rows={open ? 3 : 1}
        className={open ? PROSE : `${INPUT} w-full resize-none`}
        placeholder="+ Add idea…"
        value={text}
        onFocus={() => setOpen(true)}
        onBlur={() => !text.trim() && setOpen(false)}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void submit()
          }
        }}
      />
      {/* Always visible (M24): a voice capture must not require clicking into
          the keyboard field first. Speaking expands the row like focus does. */}
      <MicButton
        onText={(t) => {
          setOpen(true)
          setText((c) => appendText(c, t))
        }}
      />
    </div>
  )
}

export function CommandPalette({
  items,
  views,
  onRun,
  onClose
}: {
  items: Item[]
  views: string[]
  onRun: (r: PaletteResult, query: string) => void
  onClose: () => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  const results = paletteResults(query, items, views)
  const active = Math.min(sel, Math.max(results.length - 1, 0))

  return (
    <div className={`${OVERLAY} z-40`} onMouseDown={onClose}>
      <div className={`${PANEL} max-w-[560px] gap-2`} onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          className={`${INPUT} w-full`}
          placeholder="Type a command or search items…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setSel(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setSel(Math.min(active + 1, results.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setSel(Math.max(active - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              const r = results[active]
              if (r) onRun(r, query)
            }
          }}
        />
        <div className="max-h-[50vh] overflow-y-auto">
          {results.length === 0 ? (
            <p className="p-3 text-sm text-on-surface-variant">No matches.</p>
          ) : (
            results.map((r, n) => (
              <button
                key={r.key}
                className={
                  'block w-full truncate rounded px-3 py-2 text-left text-sm transition-colors ' +
                  (n === active
                    ? 'bg-surface-container-high text-on-surface'
                    : 'text-on-surface-variant hover:bg-surface-container')
                }
                onClick={() => onRun(r, query)}
              >
                {r.label}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
