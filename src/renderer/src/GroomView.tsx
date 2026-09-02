// Grooming (§7): the full-page grill interview, keyed by the item being groomed
// or the reserved _draft key from scratch. Apply is a main-process call; this
// view only renders and hands off.
import { useEffect, useRef, useState } from 'react'
import type {
  ChatEvent,
  ChatMessage,
  ChatProposal,
  ChatQuestion,
  Item,
  Role
} from '../../preload/index'
import { MicButton, ProposalPreview, QuestionCard } from './chatShared'
import { appendText, BTN_GHOST, BTN_PRIMARY, BUBBLE_AI, BUBBLE_USER, ERROR_BANNER } from './ui'

type Props = {
  repo: string
  roles: Role[]
  // The item being groomed, or null to groom from scratch under DRAFT_KEY.
  itemId?: string | null
  // Home quick-start (M23): sent as the first message when the transcript is
  // empty, so the Interview starts from what the user already typed.
  seed?: string
  // "Apply & run" on the auto-run path; default elsewhere.
  applyLabel?: string
  onApplied: (item: Item) => void
}

const EMPTY =
  "Describe what you want built — I'll ask a few questions, then propose a Spec and Stories."

// Width caps are the full-page chat's; the 340px panel drops them (§6/§7).
const USER = `max-w-[80%] ${BUBBLE_USER}`
const AI = `max-w-[80%] ${BUBBLE_AI}`

export function GroomView({
  repo,
  roles,
  itemId,
  seed,
  applyLabel = 'Apply',
  onApplied
}: Props): React.JSX.Element {
  const slug = itemId ?? window.somni.draftKey
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

  // Below `send` so the seed call isn't a use-before-declaration.
  useEffect(() => {
    if (loaded.current) return
    loaded.current = true
    void window.somni.loadChat(repo, slug).then((c) => {
      // A seed means quick-start, and quick-start means a fresh groom: an
      // abandoned _draft transcript must not swallow the typed text (#26).
      if (seed && c.messages.length > 0) {
        void window.somni.newChat(repo, slug).then(() => send(seed))
        return
      }
      setMessages(c.messages)
      if (seed) void send(seed)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per slug
  }, [repo, slug])

  const apply = async (): Promise<void> => {
    if (!proposal) return
    setApplying(true)
    const res = await window.somni.applyProposal(repo, slug, proposal)
    if (!res.ok) {
      setApplying(false)
      setError(res.error)
      return
    }
    onApplied(res.item)
  }

  const newGroom = async (): Promise<void> => {
    if (messages.length && !confirm('Start a new groom? The current transcript is discarded.'))
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
        <h2 className="font-headline-md text-headline-md font-bold">
          {itemId ? `Groom ${itemId}` : 'Groom'}
        </h2>
        <button className={BTN_GHOST} onClick={newGroom} disabled={sending}>
          New groom
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-stack-gap overflow-y-auto" ref={listRef}>
        {messages.length === 0 && !streaming && (
          <p className="m-auto max-w-[440px] text-center leading-relaxed text-on-surface-variant">
            {EMPTY}
          </p>
        )}
        {messages.map((m, i) => (
          <div className={m.role === 'user' ? 'flex w-full justify-end' : 'flex w-full'} key={i}>
            <div className={m.role === 'user' ? USER : AI}>{m.text}</div>
          </div>
        ))}
        {streaming !== null && (
          <div className="flex w-full">
            <div className={AI}>{streaming + '▌'}</div>
          </div>
        )}
        {question && !proposal && (
          <QuestionCard q={question} disabled={sending} onAnswer={(t) => void send(t)} />
        )}
        {error && (
          <div className={ERROR_BANNER}>
            {error}
            <button className={BTN_GHOST} onClick={() => void send(lastUser)} disabled={sending}>
              Retry
            </button>
          </div>
        )}
      </div>
      {proposal && (
        <ProposalPreview
          proposal={proposal}
          roles={roles}
          // An Epic Apply lands in Backlog and runs nothing — never promise
          // "& run" on it (#26 story 8).
          applyLabel={applying ? 'Applying…' : proposal.kind === 'epic' ? 'Apply' : applyLabel}
          disabled={applying}
          onApply={() => void apply()}
          onDismiss={() => setProposal(null)}
        />
      )}
      <div className="flex shrink-0 items-end gap-2 border-t border-border-subtle pt-3">
        <textarea
          className="h-20 flex-1 resize-y rounded-lg border border-border-subtle bg-surface-container px-3 py-2 font-body-md text-body-md text-on-surface focus:border-primary focus:outline-none"
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
          <button className={BTN_PRIMARY} disabled={sending || !input.trim()} onClick={submit}>
            Send
          </button>
          {/* _draft is never blocked by a running pipeline (Decision 9). */}
          <button
            className={BTN_GHOST}
            onClick={() => void send(window.somni.proposeNow)}
            disabled={sending}
          >
            Propose Now
          </button>
          <MicButton
            disabled={sending}
            onText={(text) => setInput((cur) => appendText(cur, text))}
          />
        </div>
      </div>
    </div>
  )
}
