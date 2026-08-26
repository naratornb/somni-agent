import { useEffect, useRef, useState } from 'react'
import { BTN_PRIMARY, TEXTAREA } from './ui'

type TaskEvent =
  | { kind: 'session'; sessionId: string }
  | { kind: 'text'; text: string }
  | { kind: 'result'; ok: boolean; costUsd?: number; durationMs?: number; detail?: string }
  | { kind: 'spawn-error'; message: string }
  | { kind: 'exit'; code: number | null }

const DEMO_PROMPT = 'Introduce yourself in one sentence, then tell a one-line programming joke.'

export function Playground(): React.JSX.Element {
  const [prompt, setPrompt] = useState(DEMO_PROMPT)
  const [running, setRunning] = useState(false)
  const [lines, setLines] = useState<string[]>([])
  const [footer, setFooter] = useState('')
  const paneRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    return window.somni.onTaskEvent((raw) => {
      const ev = raw as TaskEvent
      if (ev.kind === 'session') setLines((l) => [...l, `[session ${ev.sessionId}]`])
      if (ev.kind === 'text') setLines((l) => [...l, ev.text])
      if (ev.kind === 'spawn-error') setLines((l) => [...l, `[stderr] ${ev.message}`])
      if (ev.kind === 'result') {
        setFooter(
          `${ev.ok ? '✓ success' : '✗ error'}` +
            (ev.durationMs != null ? ` · ${(ev.durationMs / 1000).toFixed(1)}s` : '') +
            (ev.costUsd != null ? ` · $${ev.costUsd.toFixed(4)}` : '')
        )
      }
      if (ev.kind === 'exit') {
        setRunning(false)
        setLines((l) => [...l, `[exit code ${ev.code}]`])
      }
    })
  }, [])

  useEffect(() => {
    paneRef.current?.scrollTo(0, paneRef.current.scrollHeight)
  }, [lines])

  const run = (): void => {
    setLines([])
    setFooter('')
    setRunning(true)
    void window.somni.runTask(prompt)
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-stack-gap">
      <textarea
        className={`${TEXTAREA} rounded-lg`}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={3}
      />
      <button
        className={`self-start ${BTN_PRIMARY}`}
        onClick={run}
        disabled={running || !prompt.trim()}
      >
        {running ? 'Running…' : 'Run'}
      </button>
      {/* True black for live logs — DESIGN.md's terminal-emulation cue. */}
      <pre
        className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-border-subtle bg-black p-4 font-mono-code text-mono-code whitespace-pre-wrap text-on-surface-variant"
        ref={paneRef}
      >
        {lines.join('\n')}
      </pre>
      {footer && (
        <div className="font-mono-code text-mono-code text-on-surface-variant">{footer}</div>
      )}
    </div>
  )
}
