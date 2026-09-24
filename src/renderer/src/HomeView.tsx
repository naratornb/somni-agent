// Home (M23): the front door. One question — what do you want done overnight —
// with suggestion chips, and the live pipeline activity beneath it. The
// activity is passed as children so its eight props stay App's business.
import { useEffect, useState } from 'react'
import type { Item, Persona, ResolvedSettings } from '../../preload/index'
import { MicButton } from './chatShared'
import {
  appendText,
  BTN_PRIMARY,
  CHIP,
  CHIP_SM,
  KIND_CHIP,
  railOrder,
  sessionActivity,
  sessionChip,
  stamp,
  togglePersona
} from './ui'

// Rendered until repo:suggestions answers with something better; also the
// permanent copy for repos with no usable signals.
const FALLBACK_CHIPS = [
  'Clean up TODOs in the codebase',
  'Add tests for the most fragile area',
  'Update the README to match reality'
]

/**
 * First-run persona pick (M27 §2): one question, once. Shown by HomeView only
 * while settings.persona has never been saved; picking writes it through the
 * normal settings-save path, and the strip never shows again.
 */
export function PersonaPickStrip({ onPick }: { onPick: (p: Persona) => void }): React.JSX.Element {
  const CARD =
    'flex-1 rounded-lg border border-border-subtle bg-surface-container p-4 text-left transition-colors hover:bg-surface-container-high'
  return (
    <div className="flex shrink-0 gap-3 rounded-xl border border-border-subtle bg-surface-elevated p-card-padding">
      <button
        className={CARD}
        aria-label="Pick Technical Director"
        onClick={() => onPick('director')}
      >
        <span className="block font-semibold text-on-surface">Technical Director</span>
        <span className="text-sm text-on-surface-variant">
          somni interviews you before every proposal.
        </span>
      </button>
      <button className={CARD} aria-label="Pick Project Owner" onClick={() => onPick('owner')}>
        <span className="block font-semibold text-on-surface">Project Owner</span>
        <span className="text-sm text-on-surface-variant">
          somni drafts in the background and only asks when it&apos;s stuck.
        </span>
      </button>
    </div>
  )
}

/**
 * The quick-start box — pure props-in/callback-out, so the persona chip and
 * the Start wiring are testable without a DOM (the SettingsForm pattern, M26).
 * HomeView (below) owns the text/chips/persona state and the settings fetch.
 */
export function QuickStartBox({
  text,
  onTextChange,
  chips,
  onChipPick,
  persona,
  onPersonaToggle,
  onSubmit,
  onSpoken
}: {
  text: string
  onTextChange: (t: string) => void
  chips: string[]
  onChipPick: (c: string) => void
  persona: Persona
  onPersonaToggle: () => void
  onSubmit: () => void
  onSpoken: (t: string) => void
}): React.JSX.Element {
  return (
    <div className="flex shrink-0 flex-col gap-3 rounded-xl border border-border-subtle bg-surface-elevated p-card-padding">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-headline-md text-headline-md font-bold">
          What do you want done overnight?
        </h2>
        {/* Defaults to the settings value; a per-quick-start override only —
            never writes back (§3). */}
        <button className={CHIP} aria-label="Persona" onClick={onPersonaToggle}>
          {persona === 'owner' ? 'Project Owner' : 'Technical Director'}
        </button>
      </div>
      <div className="flex items-end gap-2">
        <textarea
          className="h-20 flex-1 resize-y rounded-lg border border-border-subtle bg-surface-container px-3 py-2 font-body-md text-body-md text-on-surface focus:border-primary focus:outline-none"
          placeholder="Describe a task — somni grooms it into a story and runs it…"
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              onSubmit()
            }
          }}
        />
        <div className="flex flex-col gap-2">
          <button
            className={BTN_PRIMARY}
            aria-label="Start"
            disabled={!text.trim()}
            onClick={onSubmit}
          >
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
            onClick={() => onChipPick(c)}
          >
            {c}
          </button>
        ))}
      </div>
    </div>
  )
}

export function HomeView({
  repo,
  items = [],
  onStart,
  onGroom,
  onViewAll,
  children
}: {
  repo: string
  items?: Item[]
  onStart: (text: string, persona: Persona) => void
  onGroom?: (item: Item) => void
  onViewAll?: () => void
  children?: React.ReactNode
}): React.JSX.Element {
  const [text, setText] = useState('')
  const [chips, setChips] = useState<string[]>(FALLBACK_CHIPS)
  const [settings, setSettings] = useState<ResolvedSettings | null>(null)
  // The Quick Start chip (§3): defaults to the settings value once it loads,
  // but toggling here never writes back — it's this one groom's pick.
  const [chipPersona, setChipPersona] = useState<Persona>('director')

  useEffect(() => {
    void window.somni.suggestions(repo).then((s) => {
      if (s.length) setChips(s)
    })
    // The chip's default is set once, on load — a pick made afterward (below)
    // updates it directly, not through a second state-syncing effect.
    void window.somni.getSettings().then((s) => {
      setSettings(s)
      setChipPersona(s.persona ?? 'director')
    })
  }, [repo])

  // Voice quick-start (M24): off = dictation fills the box for a glance;
  // on = speaking starts the groom immediately, seeded with the words.
  const autoGroom = !!settings?.voiceAutoGroom

  const onSpoken = (spoken: string): void => {
    const next = appendText(text, spoken)
    setText(next)
    if (autoGroom && next.trim()) onStart(next.trim(), chipPersona)
  }

  const submit = (): void => {
    if (text.trim()) onStart(text.trim(), chipPersona)
  }

  // First-run pick (§2): writes through the normal settings-save path, same
  // as Settings' own Persona select — the strip is gone on the next load.
  const pickPersona = (p: Persona): void => {
    void window.somni.setSettings({ persona: p }).then(() => {
      setSettings((s) => (s ? { ...s, persona: p } : s))
      setChipPersona(p)
    })
  }

  const { focused, compact, overflow } = railOrder(items)
  const open = (i: Item): void => onGroom?.(i)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6">
      {settings && settings.persona === undefined && <PersonaPickStrip onPick={pickPersona} />}
      <QuickStartBox
        text={text}
        onTextChange={setText}
        chips={chips}
        onChipPick={setText}
        persona={chipPersona}
        onPersonaToggle={() => setChipPersona(togglePersona)}
        onSubmit={submit}
        onSpoken={onSpoken}
      />
      {/* Session rail (M25.4): only when there is a live session — otherwise
          Home is exactly the quick-start box over the pipeline. */}
      {focused && (
        <section className="flex shrink-0 flex-col gap-2">
          <div
            className="flex cursor-pointer items-center justify-between gap-4 rounded-xl border border-primary/40 bg-surface-elevated p-card-padding transition-colors hover:bg-surface-container"
            onClick={() => open(focused)}
          >
            <div className="flex min-w-0 flex-col gap-1">
              <span className="truncate font-headline-lg text-headline-lg font-bold text-on-surface">
                {focused.name}
              </span>
              <span className="font-mono-code text-xs text-on-surface-variant">
                {focused.id} · {stamp(sessionActivity(focused))}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <span className={KIND_CHIP[focused.kind]}>{focused.kind}</span>
              <span className={sessionChip(focused.groomState).cls}>
                {sessionChip(focused.groomState).label}
              </span>
              {focused.groomState === 'needs-review' && (
                <button className={BTN_PRIMARY} onClick={() => open(focused)}>
                  Review
                </button>
              )}
            </div>
          </div>
          {compact.map((i) => (
            <div
              className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border border-border-subtle bg-surface-elevated px-3 py-2 transition-colors hover:bg-surface-container"
              key={i.id}
              onClick={() => open(i)}
            >
              <span className="truncate text-on-surface">{i.name}</span>
              <div className="flex shrink-0 items-center gap-2">
                <span className={sessionChip(i.groomState).cls}>
                  {sessionChip(i.groomState).label}
                </span>
                <span className={CHIP_SM}>{i.id}</span>
              </div>
            </div>
          ))}
          {overflow > 0 && (
            <button
              className="self-start text-sm text-primary hover:underline"
              onClick={() => onViewAll?.()}
            >
              View all {overflow + compact.length + 1} → Sessions
            </button>
          )}
        </section>
      )}
      {children}
    </div>
  )
}
