import { useEffect, useRef, useState } from 'react'
import type { ChatEvent, ChatMessage, ChatProposal, ChatQuestion, Role } from '../../preload/index'
import { ProposalPreview, QuestionCard } from './chatShared'
import { BTN_GHOST_SM, BTN_PRIMARY, BUBBLE_AI, BUBBLE_USER, ERROR_BANNER } from './ui'

type Props = {
  repo: string
  slug: string
  roles: Role[]
  open: boolean
  running: boolean
  onApply: (proposal: ChatProposal) => void
}

const EMPTY =
  "Describe what this workflow should do — I'll ask a few questions, then propose the tasks."

export function DraftChatPanel({
  repo,
  slug,
  roles,
  open,
  running,
  onApply
}: Props): React.JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [question, setQuestion] = useState<ChatQuestion | null>(null)
  const [proposal, setProposal] = useState<ChatProposal | null>(null)
  const [input, setInput] = useState('')
  const [lastUser, setLastUser] = useState('')
  const loaded = useRef(false)
  const listRef = useRef<HTMLDivElement>(null)

  const sending = streaming !== null

  useEffect(() => {
    if (!open || loaded.current) return
    loaded.current = true
    void window.somni.loadChat(repo, slug).then((c) => setMessages(c.messages))
  }, [open, repo, slug])

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
        // Single slot: a proposal wins, otherwise the turn's question.
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
    if (!text.trim() || sending || running) return
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

  const newChat = async (): Promise<void> => {
    if (messages.length && !confirm('Start a new chat? The current transcript is discarded.'))
      return
    await window.somni.newChat(repo, slug)
    setMessages([])
    setStreaming(null)
    setError(null)
    setQuestion(null)
    setProposal(null)
  }

  return (
    <div
      className="flex h-full w-editor-panel-width shrink-0 flex-col gap-3 rounded-xl border border-border-subtle bg-surface-elevated p-4"
      style={open ? undefined : { display: 'none' }}
    >
      <div className="flex items-center justify-between">
        <span className="font-headline-md text-sm font-semibold">Draft with AI</span>
        <div className="flex gap-2">
          <button className={BTN_GHOST_SM} onClick={newChat} disabled={running}>
            New chat
          </button>
          <button
            className={BTN_GHOST_SM}
            onClick={() => void send(window.somni.refineStructure)}
            disabled={sending || running}
          >
            Refine structure
          </button>
          <button
            className={BTN_GHOST_SM}
            onClick={() => void send(window.somni.proposeNow)}
            disabled={sending || running}
          >
            Propose Now
          </button>
        </div>
      </div>
      {running ? (
        <p className="text-sm text-on-surface-variant">
          Chat is disabled while this workflow is running.
        </p>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto" ref={listRef}>
        {messages.length === 0 && !streaming && (
          <p className="text-sm text-on-surface-variant">{EMPTY}</p>
        )}
        {/* No width caps in the 340px panel (§7) — otherwise identical to the
            full-page Draft chat, which is what makes them read as one component. */}
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
          <QuestionCard q={question} disabled={sending || running} onAnswer={(t) => void send(t)} />
        )}
        {error && (
          <div className={ERROR_BANNER}>
            {error}
            <button className={BTN_GHOST_SM} onClick={() => void send(lastUser)} disabled={running}>
              Retry
            </button>
          </div>
        )}
      </div>
      {proposal && (
        <ProposalPreview
          proposal={proposal}
          roles={roles}
          disabled={running}
          onApply={() => onApply(proposal)}
          onDismiss={() => setProposal(null)}
        />
      )}
      <textarea
        className="w-full resize-none rounded-lg border border-border-subtle bg-surface-container p-2.5 text-sm text-on-surface focus:border-primary focus:outline-none"
        rows={2}
        placeholder="Describe the workflow…"
        value={input}
        disabled={sending || running}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            const text = input
            setInput('')
            void send(text)
          }
        }}
      />
      <button
        className={`self-end ${BTN_PRIMARY}`}
        disabled={sending || running || !input.trim()}
        onClick={() => {
          const text = input
          setInput('')
          void send(text)
        }}
      >
        Send
      </button>
    </div>
  )
}
