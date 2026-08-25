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
    // ponytail: `.stack` is already the full-height flex column the spec wants
    // — no .draft-view class needed.
    <div className="stack">
      <div className="row">
        <b>Draft</b>
        <button className="ghost" onClick={newDraft} disabled={sending}>
          New draft
        </button>
      </div>
      <div className="chat-messages" ref={listRef}>
        {messages.length === 0 && !streaming && <p className="draft-empty">{EMPTY}</p>}
        {messages.map((m, i) => (
          <div className={`chat-msg ${m.role}`} key={i}>
            {m.text}
          </div>
        ))}
        {streaming !== null && <div className="chat-msg assistant">{streaming + '▌'}</div>}
        {question && !proposal && (
          <QuestionCard q={question} disabled={sending} onAnswer={(t) => void send(t)} />
        )}
        {error && (
          <div className="error-banner">
            {error}{' '}
            <button className="ghost" onClick={() => void send(lastUser)} disabled={sending}>
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
      <div className="row">
        {/* _draft is never blocked by a running pipeline (Decision 9). */}
        <button
          className="ghost"
          onClick={() => void send(window.somni.proposeNow)}
          disabled={sending}
        >
          Propose Now
        </button>
      </div>
      <textarea
        rows={3}
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
      <button disabled={sending || !input.trim()} onClick={submit}>
        Send
      </button>
    </div>
  )
}
