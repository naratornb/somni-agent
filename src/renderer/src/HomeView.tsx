// Home (M23): the front door. One question — what do you want done overnight —
// with suggestion chips, and the live pipeline activity beneath it. The
// activity is passed as children so its eight props stay App's business.
import { useEffect, useState } from 'react'
import { MicButton } from './chatShared'
import { appendText, BTN_PRIMARY, CHIP } from './ui'

// Rendered until repo:suggestions answers with something better; also the
// permanent copy for repos with no usable signals.
const FALLBACK_CHIPS = [
  'Clean up TODOs in the codebase',
  'Add tests for the most fragile area',
  'Update the README to match reality'
]

export function HomeView({
  repo,
  onStart,
  children
}: {
  repo: string
  onStart: (text: string) => void
  children?: React.ReactNode
}): React.JSX.Element {
  const [text, setText] = useState('')
  const [chips, setChips] = useState<string[]>(FALLBACK_CHIPS)
  // Voice quick-start (M24): off = dictation fills the box for a glance;
  // on = speaking starts the groom immediately, seeded with the words.
  const [autoGroom, setAutoGroom] = useState(false)

  useEffect(() => {
    void window.somni.suggestions(repo).then((s) => {
      if (s.length) setChips(s)
    })
    void window.somni.getSettings().then((s) => setAutoGroom(!!s.voiceAutoGroom))
  }, [repo])

  const onSpoken = (spoken: string): void => {
    const next = appendText(text, spoken)
    setText(next)
    if (autoGroom && next.trim()) onStart(next.trim())
  }

  const submit = (): void => {
    if (text.trim()) onStart(text.trim())
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6">
      <div className="flex shrink-0 flex-col gap-3 rounded-xl border border-border-subtle bg-surface-elevated p-card-padding">
        <h2 className="font-headline-md text-headline-md font-bold">
          What do you want done overnight?
        </h2>
        <div className="flex items-end gap-2">
          <textarea
            className="h-20 flex-1 resize-y rounded-lg border border-border-subtle bg-surface-container px-3 py-2 font-body-md text-body-md text-on-surface focus:border-primary focus:outline-none"
            placeholder="Describe a task — somni grooms it into a story and runs it…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
          />
          <div className="flex flex-col gap-2">
            <button className={BTN_PRIMARY} disabled={!text.trim()} onClick={submit}>
              Start
            </button>
            <MicButton onText={onSpoken} />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {/* Chips fill the box, never submit — the user edits before committing. */}
          {chips.map((c) => (
            <button
              key={c}
              className={`${CHIP} cursor-pointer transition-colors hover:bg-surface-container-high hover:text-on-surface`}
              onClick={() => setText(c)}
            >
              {c}
            </button>
          ))}
        </div>
      </div>
      {children}
    </div>
  )
}
