// Pieces shared by the grooming surface and the field-level Refine controls
// (§7). Rendering only — every decision is main's.
import { useEffect, useRef, useState } from 'react'
import type { ChatProposal, ChatQuestion, Role } from '../../preload/index'
import {
  BTN_GHOST,
  BTN_GHOST_SM,
  BTN_PRIMARY,
  CHIP,
  ERROR_BANNER,
  STATUS_CHIP,
  STATUS_CHIP_BASE
} from './ui'

// The question/proposal cards reuse the AI bubble treatment so they read as
// "the AI's turn", not a widget bolted onto the chat (M10-ui.md §4).
const CARD =
  'bg-surface-container-lowest border border-border-subtle rounded-xl p-4 flex flex-col gap-3 max-w-3xl'

export function QuestionCard({
  q,
  disabled,
  onAnswer
}: {
  q: ChatQuestion
  disabled: boolean
  onAnswer: (text: string) => void
}): React.JSX.Element {
  return (
    <div className={CARD}>
      <p className="text-sm text-on-surface">{q.question}</p>
      <div className="flex flex-wrap gap-2">
        {q.options.map((opt) => (
          <button
            key={opt}
            // Recommended is the one filled-primary pill outside a primary
            // button — DESIGN.md's "start here" nudge.
            className={
              opt === q.recommended
                ? 'rounded-full bg-primary-container px-3 py-1.5 text-sm font-medium text-on-primary-container transition-opacity hover:opacity-90 disabled:opacity-40'
                : 'rounded-full bg-surface-variant px-3 py-1.5 text-sm text-on-surface-variant transition-colors hover:bg-surface-container-high disabled:opacity-40'
            }
            disabled={disabled}
            onClick={() => onAnswer(opt)}
          >
            {opt}
          </button>
        ))}
      </div>
    </div>
  )
}

export function ProposalPreview({
  proposal,
  roles,
  applyLabel = 'Apply',
  disabled,
  onApply,
  onDismiss
}: {
  proposal: ChatProposal
  roles: Role[]
  applyLabel?: string
  disabled: boolean
  onApply: () => void
  onDismiss: () => void
}): React.JSX.Element {
  const existing = new Set(roles.map((r) => r.slug))
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
  return (
    <div className={`${CARD} max-h-[40vh] shrink-0 overflow-y-auto`}>
      <span className="text-sm text-on-surface-variant">
        Proposed {proposal.kind === 'epic' ? 'Epic' : 'Story'} — {proposal.name} —{' '}
        {proposal.kind === 'epic'
          ? `${proposal.stories.length} ${proposal.stories.length === 1 ? 'story' : 'stories'}`
          : plural(proposal.tasks.length, 'subtask')}
        {proposal.roles.length ? `, ${plural(proposal.roles.length, 'new role')}` : ''}
      </span>
      {proposal.spec && (
        // Left-accent border marks the read-only source of truth (DESIGN.md).
        <details className="overflow-hidden rounded-lg border border-l-2 border-border-subtle border-l-primary-container bg-surface">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-on-surface-variant hover:text-on-surface">
            Spec
          </summary>
          <p className="px-4 pb-3 text-sm whitespace-pre-wrap text-on-surface-variant">
            {proposal.spec}
          </p>
        </details>
      )}
      {/* Epic: one card per child Story (its own subtasks nested); Story: the
          subtasks directly. Blocking edges are indices into this same list. */}
      {proposal.stories.map((s, i) => (
        <div
          className="flex flex-col gap-1 rounded-lg border border-border-subtle bg-surface p-3"
          key={i}
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-on-surface">{s.name}</span>
            <span className={CHIP}>
              {s.tasks.length} subtask{s.tasks.length === 1 ? '' : 's'}
            </span>
            {s.blockedBy.length > 0 && (
              <span className={CHIP}>
                blocked by {s.blockedBy.map((b) => proposal.stories[b]?.name ?? b).join(', ')}
              </span>
            )}
          </div>
          <span className="text-sm text-on-surface-variant">{s.spec}</span>
        </div>
      ))}
      {proposal.tasks.map((t, i) => (
        <div
          className="flex flex-col gap-1 rounded-lg border border-border-subtle bg-surface p-3"
          key={i}
        >
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-on-surface">{t.title}</span>
            {t.role && <span className={CHIP}>{t.role}</span>}
          </div>
          <span className="text-sm text-on-surface-variant">{t.prompt}</span>
        </div>
      ))}
      {proposal.roles.map((r) => (
        <div
          className="flex flex-col gap-1 rounded-lg border border-border-subtle bg-surface p-3"
          key={r.slug}
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-on-surface">{r.name}</span>
            <span className={CHIP}>{r.slug}</span>
            {existing.has(r.slug) && (
              <span className={`${STATUS_CHIP_BASE} ${STATUS_CHIP.Skipped}`}>
                already exists — will reuse
              </span>
            )}
          </div>
          <span className="text-sm text-on-surface-variant">{r.preamble}</span>
        </div>
      ))}
      <div className="flex items-center gap-3 pt-1">
        <button className={BTN_PRIMARY} onClick={onApply} disabled={disabled}>
          {applyLabel}
        </button>
        <button className={BTN_GHOST} onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  )
}

// One-shot Refine (M11 Decision 2). The result is inert: Apply hands it to the
// caller's editing buffer only — disk is written by the editor's own Save.
export function RefineControl({
  repo,
  kind,
  text,
  onApply
}: {
  repo: string
  kind: 'task' | 'role'
  text: string
  onApply: (text: string) => void
}): React.JSX.Element {
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refine = async (): Promise<void> => {
    setPending(true)
    setError(null)
    setResult(null)
    const res = await window.somni.refineField(repo, kind, text)
    setPending(false)
    if (!res.ok) return setError(res.error ?? 'refine failed')
    setResult(res.text ?? '')
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        className={`flex items-center gap-1 self-start ${BTN_GHOST_SM}`}
        disabled={!text.trim() || pending}
        onClick={() => void refine()}
      >
        <span className="material-symbols-outlined text-[16px]">auto_awesome</span>
        {pending ? 'Refining…' : 'Refine'}
      </button>
      {error && (
        <div className={ERROR_BANNER}>
          {error}
          <button className={BTN_GHOST_SM} onClick={() => void refine()}>
            Retry
          </button>
        </div>
      )}
      {result !== null && (
        <div className={CARD}>
          <span className="text-sm text-on-surface-variant">
            Refined {kind === 'task' ? 'task prompt' : 'role preamble'}
          </span>
          <p className="text-sm whitespace-pre-wrap text-on-surface">{result}</p>
          <div className="flex items-center gap-3 pt-1">
            <button
              className={BTN_PRIMARY}
              onClick={() => {
                onApply(result)
                setResult(null)
              }}
            >
              Apply
            </button>
            <button className={BTN_GHOST} onClick={() => setResult(null)}>
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// Voice input (M12). Capture lives here — the only renderer-side voice logic —
// and it stays deliberately small: mic → 16 kHz AudioContext → one Float32Array
// over invoke. Everything else (WAV encoding, whisper.cpp, the model) is main's.
// ponytail: ScriptProcessorNode is deprecated but works and needs no worklet
// asset in the electron-vite build — move to AudioWorklet if it ever misbehaves.
type Capture = { stop: () => Float32Array }

async function startCapture(): Promise<Capture> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const ctx = new AudioContext({ sampleRate: 16000 })
  const node = ctx.createScriptProcessor(4096, 1, 1)
  const chunks: Float32Array[] = []
  node.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)))
  ctx.createMediaStreamSource(stream).connect(node)
  node.connect(ctx.destination)
  return {
    stop: () => {
      node.disconnect()
      void ctx.close()
      stream.getTracks().forEach((t) => t.stop())
      const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0))
      let at = 0
      for (const c of chunks) {
        out.set(c, at)
        at += c.length
      }
      return out
    }
  }
}

type MicState =
  'checking' | 'no-binary' | 'no-model' | 'downloading' | 'idle' | 'recording' | 'busy'

const NO_BINARY_HINT = 'Install whisper.cpp (brew install whisper-cpp) or set the path in Settings'

/** Mic button beside an AI-adjacent text field. `onText` appends to the field. */
export function MicButton({
  onText,
  disabled
}: {
  onText: (text: string) => void
  disabled?: boolean
}): React.JSX.Element {
  const [state, setState] = useState<MicState>('checking')
  const [pct, setPct] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const capture = useRef<Capture | null>(null)

  useEffect(() => {
    void window.somni
      .voiceStatus()
      .then(({ binary, model }) => setState(!binary ? 'no-binary' : !model ? 'no-model' : 'idle'))
    const off = window.somni.onVoiceProgress(({ received, total }) =>
      setPct(total ? Math.round((received / total) * 100) : 0)
    )
    return () => {
      off()
      // Unmounting mid-recording (a view switch) must release the mic, or the
      // OS indicator stays on forever. The samples go nowhere — no field left.
      capture.current?.stop()
      capture.current = null
    }
  }, [])

  const click = async (): Promise<void> => {
    setError(null)
    // Download before recording: the reverse would waste the user's speech.
    if (state === 'no-model') {
      setState('downloading')
      const res = await window.somni.downloadModel()
      if (!res.ok) {
        setState('no-model')
        return setError(res.error ?? 'model download failed')
      }
      return setState('idle')
    }
    if (state === 'idle') {
      try {
        capture.current = await startCapture()
        return setState('recording')
      } catch {
        return setError('mic access denied — System Settings')
      }
    }
    if (state === 'recording') {
      const samples = capture.current?.stop() ?? new Float32Array(0)
      capture.current = null
      setState('busy')
      const res = await window.somni.transcribe(samples)
      setState('idle')
      if (!res.ok) return setError(res.error ?? 'transcription failed')
      if (res.text) onText(res.text)
    }
  }

  const label: Record<MicState, string> = {
    checking: '…',
    'no-binary': 'Voice',
    'no-model': 'Enable voice',
    downloading: `Downloading ${pct}%`,
    idle: 'Speak',
    recording: 'Stop',
    busy: 'Transcribing…'
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        className={`flex items-center gap-1 self-start ${BTN_GHOST_SM} ${
          state === 'recording' ? `${STATUS_CHIP_BASE} ${STATUS_CHIP.Running}` : ''
        }`}
        title={state === 'no-binary' ? NO_BINARY_HINT : 'Voice input'}
        disabled={
          disabled ||
          state === 'checking' ||
          state === 'no-binary' ||
          state === 'downloading' ||
          state === 'busy'
        }
        onClick={() => void click()}
      >
        <span className="material-symbols-outlined text-[16px]">mic</span>
        {label[state]}
      </button>
      {error && <div className={ERROR_BANNER}>{error}</div>}
    </div>
  )
}
