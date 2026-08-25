import { useEffect, useRef, useState } from 'react'
import type { ChatEvent, ChatMessage, ChatProposal } from '../../preload/index'

type Props = {
  repo: string
  slug: string
  open: boolean
  running: boolean
  onApply: (proposal: ChatProposal) => void
}

const EMPTY =
  "Describe what this workflow should do — I'll ask a few questions, then propose the tasks."

export function DraftChatPanel({ repo, slug, open, running, onApply }: Props): React.JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
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
        if (ev.proposal) setProposal(ev.proposal)
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
    setProposal(null)
  }

  return (
    <div className="chat-panel" style={open ? undefined : { display: 'none' }}>
      <div className="row">
        <b>Draft with AI</b>
        <button className="ghost" onClick={newChat} disabled={running}>
          New chat
        </button>
      </div>
      {running ? <p className="dim">Chat is disabled while this workflow is running.</p> : null}
      <div className="chat-messages" ref={listRef}>
        {messages.length === 0 && !streaming && <p className="dim">{EMPTY}</p>}
        {messages.map((m, i) => (
          <div className={`chat-msg ${m.role}`} key={i}>
            {m.text}
          </div>
        ))}
        {streaming !== null && <div className="chat-msg assistant">{streaming + '▌'}</div>}
        {error && (
          <div className="error-banner">
            {error}{' '}
            <button className="ghost" onClick={() => void send(lastUser)} disabled={running}>
              Retry
            </button>
          </div>
        )}
      </div>
      {proposal && (
        <div className="proposal-pane">
          <span className="dim">
            Proposed update — {proposal.tasks.length} task
            {proposal.tasks.length === 1 ? '' : 's'}
          </span>
          {proposal.tasks.map((t, i) => (
            <div className="task-card proposed" key={i}>
              <div className="row">
                <b>{t.title}</b>
                {t.role && <span className="chip">{t.role}</span>}
              </div>
              <span className="dim">{t.prompt}</span>
            </div>
          ))}
          <div className="row">
            <button onClick={() => onApply(proposal)} disabled={running}>
              Apply
            </button>
            <button className="ghost" onClick={() => setProposal(null)}>
              Dismiss
            </button>
          </div>
        </div>
      )}
      <textarea
        rows={3}
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
