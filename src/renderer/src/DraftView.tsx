// Brief-first drafting (§7): a full-page interview under the reserved _draft
// key. Apply is a main-process call; this view only renders and hands off.
import { useEffect, useRef, useState } from 'react'
import type {
  ChatEvent,
  ChatMessage,
  ChatProposal,
  ChatQuestion,
  Role,
  Workflow
} from '../../preload/index'
import { ProposalPreview, QuestionCard } from './chatShared'

type Props = {
  repo: string
  roles: Role[]
  onApplied: (workflow: Workflow) => void
}

const EMPTY = "Describe what you want built — I'll ask a few questions, then propose a workflow."

// Mock: drafting_interface/code.html. User bubbles right-aligned + ghost-bordered,
// AI bubbles left-aligned on the lowest surface (DESIGN.md, unified chat).
const BUBBLE_USER =
  'max-w-[80%] rounded-xl border border-border-subtle bg-surface-elevated p-4 whitespace-pre-wrap text-on-surface'
const BUBBLE_AI =
  'w-full max-w-3xl rounded-xl border border-border-subtle bg-surface-container-lowest p-4 font-mono-code text-mono-code whitespace-pre-wrap text-on-surface-variant'

export function DraftView({ repo, roles, onApplied }: Props): React.JSX.Element {
  const slug = window.somni.draftKey
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [question, setQuestion] = useState<ChatQuestion | null>(null)
  const [proposal, setProposal] = useState<ChatProposal | null>(null)
  const [applying, setApplying] = useState(false)
  const [input, setInput] = useState('')
  const [lastUser, setLastUser] = useState('')
  const loaded = useRef(false)
  const listRef = useRef<HTMLDivElement>(null)

  const sending = streaming !== null

  useEffect(() => {
    if (loaded.current) return
    loaded.current = true
    void window.somni.loadChat(repo, slug).then((c) => setMessages(c.messages))
  }, [repo, slug])

  useEffect(() => {
    const off = window.somni.onChatEvent((ev: ChatEvent) => {
      if (ev.slug !== slug) return
      if (ev.kind === 'text') setStreaming((s) => (s ?? '') + ev.text)
      if (ev.kind === 'error') {
        setStreaming(null)
        setError(ev.message)
      }
      if (ev.kind === 'done') {
        setStreaming(null)
        setMessages((m) => [...m, ev.message])
        // Single slot: only the latest turn's actionable card is shown.
        setProposal(ev.proposal)
        setQuestion(ev.proposal ? null : ev.question)
      }
    })
    return off
  }, [slug])

  useEffect(() => {
    listRef.current?.scrollTo(0, listRef.current.scrollHeight)
  }, [messages.length, streaming])

  const send = async (text: string): Promise<void> => {
    if (!text.trim() || sending) return
    setError(null)
    setLastUser(text)
    setMessages((m) => [...m, { role: 'user', text, ts: new Date().toISOString() }])
    setStreaming('')
    const res = await window.somni.sendChat(repo, slug, text)
    if (!res.ok) {
      setStreaming(null)
      setError(res.error ?? 'chat failed')
    }
  }

  const apply = async (): Promise<void> => {
    if (!proposal) return
    setApplying(true)
    const res = await window.somni.applyProposal(repo, slug, proposal)
    if (!res.ok) {
      setApplying(false)
      setError(res.error)
      return
    }
    onApplied(res.workflow)
  }

  const newDraft = async (): Promise<void> => {
    if (messages.length && !confirm('Start a new draft? The current transcript is discarded.'))
      return
    await window.somni.newChat(repo, slug)
    setMessages([])
    setStreaming(null)
    setError(null)
    setQuestion(null)
    setProposal(null)
    setInput('')
  }

  const submit = (): void => {
    const text = input
    setInput('')
    void send(text)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-stack-gap">
      <div className="flex shrink-0 items-center gap-4 border-b border-border-subtle pb-4">
        <h2 className="font-headline-md text-headline-md font-bold">Draft</h2>
        <button
          className="rounded-md border border-border-subtle bg-surface-container-high px-3 py-1 text-sm text-on-surface-variant transition-colors hover:bg-surface-variant disabled:opacity-50"
          onClick={newDraft}
          disabled={sending}
        >
          New draft
        </button>
      </div>
      <div
        className="custom-scrollbar flex min-h-0 flex-1 flex-col gap-stack-gap overflow-y-auto"
        ref={listRef}
      >
        {messages.length === 0 && !streaming && (
          <p className="m-auto max-w-[440px] text-center leading-relaxed text-on-surface-variant">
            {EMPTY}
          </p>
        )}
        {messages.map((m, i) => (
          <div className={m.role === 'user' ? 'flex w-full justify-end' : 'flex w-full'} key={i}>
            <div className={m.role === 'user' ? BUBBLE_USER : BUBBLE_AI}>{m.text}</div>
          </div>
        ))}
        {streaming !== null && (
          <div className="flex w-full">
            <div className={BUBBLE_AI}>{streaming + '▌'}</div>
          </div>
        )}
        {question && !proposal && (
          <QuestionCard q={question} disabled={sending} onAnswer={(t) => void send(t)} />
        )}
        {error && (
          <div className="flex items-center gap-2 rounded-lg border border-status-failed/20 bg-status-failed/10 px-3 py-2 font-mono-code text-mono-code text-status-failed">
            {error}
            <button
              className="rounded border border-border-subtle bg-surface-container px-2 py-1 text-xs text-on-surface disabled:opacity-50"
              onClick={() => void send(lastUser)}
              disabled={sending}
            >
              Retry
            </button>
          </div>
        )}
      </div>
      {proposal && (
        <ProposalPreview
          proposal={proposal}
          roles={roles}
          applyLabel={applying ? 'Applying…' : 'Apply'}
          disabled={applying}
          onApply={() => void apply()}
          onDismiss={() => setProposal(null)}
        />
      )}
      <div className="flex shrink-0 items-end gap-2 border-t border-border-subtle pt-3">
        <textarea
          className="custom-scrollbar h-20 flex-1 resize-y rounded-lg border border-border-subtle bg-surface-container px-3 py-2 font-body-md text-body-md text-on-surface focus:border-primary focus:outline-none"
          placeholder="Describe what you want built…"
          value={input}
          disabled={sending}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div className="flex flex-col gap-2">
          <button
            className="rounded-full bg-primary-container px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-inverse-primary disabled:opacity-50"
            disabled={sending || !input.trim()}
            onClick={submit}
          >
            Send
          </button>
          {/* _draft is never blocked by a running pipeline (Decision 9). */}
          <button
            className="rounded-full border border-border-subtle bg-surface-container px-4 py-2 text-sm text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-primary disabled:opacity-50"
            onClick={() => void send(window.somni.proposeNow)}
            disabled={sending}
          >
            Propose Now
          </button>
        </div>
      </div>
    </div>
  )
}
