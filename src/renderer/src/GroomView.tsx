// Grooming (§7): the full-page grill interview, always keyed by the item being
// groomed — every Groom is an Item from birth (M25.1). Apply is a main-process
// call; this view only renders and hands off.
import { useEffect, useRef, useState } from 'react'
import type {
  ChatEvent,
  ChatMessage,
  ChatProposal,
  ChatQuestion,
  GroomState,
  Item,
  Persona,
  Role
} from '../../preload/index'
import { MicButton, ProposalPreview, QuestionCard, StreamingBubble } from './chatShared'
import {
  alreadyParkedForReview,
  appendText,
  briefSummary,
  BTN_GHOST,
  BTN_PRIMARY,
  BUBBLE_AI,
  BUBBLE_USER,
  CHIP,
  consumeAskMore,
  ERROR_BANNER,
  nextRounds,
  shouldAutoHandoff,
  shouldOfferAskMore,
  shouldSeedProposal
} from './ui'

type Props = {
  repo: string
  roles: Role[]
  // The item being groomed — created by the door before this view mounts.
  itemId: string
  // Its name at mount; the AI auto-title and manual rename update it in place.
  itemName: string
  // Its session state at mount (M25.5); transitions arrive as chat events.
  groomState?: GroomState
  // The full record, when the caller already has it (M27) — the source for the
  // header persona chip and the owner mount-handoff's content check. Absent for
  // a groom just created this tick (App hasn't refreshed data.items yet); the
  // chip then shows the director fallback until the next refresh.
  item?: Item
  // Fix (M27 final review): the settings-level persona, resolved the same way
  // main does (chat.ts's personaOf: item stamp → settings → director) — an
  // unstamped item (Board/Capture, never persona-stamped) must not silently
  // fall to the director default when a Project Owner is set in Settings.
  defaultPersona?: Persona
  // Home quick-start (M23): sent as the first message when the transcript is
  // empty, so the Interview starts from what the user already typed.
  seed?: string
  // "Apply & run" on the auto-run path; default elsewhere.
  applyLabel?: string
  // `children` is present only on the needs-review Approve & run path — see
  // ProposalSection below. Every other apply (inline interview, quick-start
  // auto-run) calls this with just the item, as before.
  onApplied: (item: Item, children?: Item[]) => void
}

const EMPTY =
  "Describe what you want built — I'll ask a few questions, then propose a Spec and Stories."

// Width caps are the full-page chat's; the 340px panel drops them (§6/§7).
const USER = `max-w-[80%] ${BUBBLE_USER}`
const AI = `max-w-[80%] ${BUBBLE_AI}`

/**
 * The proposal card, pure props-in/callback-out — GroomView (below) owns the
 * chat state and IPC calls; this is what makes the needs-review Approve & run
 * labeling/routing testable without a DOM, the same way SettingsForm made the
 * Providers panel testable (M26).
 */
export function ProposalSection({
  proposal,
  roles,
  fromWorkUnit,
  applying,
  applyLabel,
  onApply,
  onApproveRun,
  onDismiss
}: {
  proposal: ChatProposal
  roles: Role[]
  // Approve & run's gate (M27 §7 fix) — true only for a completed background
  // brief: a work-unit turn's proposal, or a session already parked
  // needs-review when the view loaded. Never a live interactive turn's
  // proposal, even though chat.ts parks groomState 'needs-review' for that
  // too — see ui.ts's alreadyParkedForReview.
  fromWorkUnit: boolean
  applying: boolean
  applyLabel: string
  onApply: () => void
  onApproveRun: () => void
  onDismiss: () => void
}): React.JSX.Element {
  // An Epic Apply lands in Backlog and runs nothing — never promise "& run" or
  // a queueing secondary on it (#26 story 8).
  const needsReview = fromWorkUnit && proposal.kind !== 'epic'
  const primary = applying
    ? 'Applying…'
    : proposal.kind === 'epic'
      ? 'Apply'
      : needsReview
        ? 'Approve & run'
        : applyLabel
  return (
    <ProposalPreview
      proposal={proposal}
      roles={roles}
      applyLabel={primary}
      disabled={applying}
      onApply={needsReview ? onApproveRun : onApply}
      onDismiss={onDismiss}
      summary={needsReview ? briefSummary(proposal.spec) : null}
      secondaryLabel={needsReview ? 'Apply' : undefined}
      onSecondary={needsReview ? onApply : undefined}
    />
  )
}

export function GroomView({
  repo,
  roles,
  itemId,
  itemName,
  groomState,
  item,
  defaultPersona,
  seed,
  applyLabel = 'Apply',
  onApplied
}: Props): React.JSX.Element {
  const slug = itemId
  const [name, setName] = useState(itemName)
  const [state, setState] = useState<GroomState | null>(groomState ?? null)
  // Header persona chip (§4): resolved fresh every render from the current
  // props, not seeded once via useState — a quick-start's `item` prop arrives
  // after mount (App hasn't refreshed data.items yet on the first render), and
  // a useState initializer never re-runs to pick it up. `personaOverride` holds
  // only an explicit flip (flipPersona below); once the item prop catches up
  // (App's refresh after saveItem), the stamped value on `item` wins again.
  const [personaOverride, setPersonaOverride] = useState<Persona | null>(null)
  const persona: Persona = item?.persona ?? personaOverride ?? defaultPersona ?? 'director'
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [question, setQuestion] = useState<ChatQuestion | null>(null)
  const [proposal, setProposal] = useState<ChatProposal | null>(null)
  // Approve & run's gate (M27 §7 fix): true for a completed background brief
  // only — set from `ev.workUnit` on every live 'done' event, initialized from
  // whether the session was already parked needs-review when this view
  // mounted (a reopened session, no live event yet this mount).
  const [fromWorkUnit, setFromWorkUnit] = useState(alreadyParkedForReview(groomState))
  const [applying, setApplying] = useState(false)
  const [input, setInput] = useState('')
  const [lastUser, setLastUser] = useState('')
  // Ask-more (M29 item 9): interview rounds already spent, from loadChat —
  // the cap that would otherwise silently route the NEXT answer into a
  // background draft. `askMoreNext` is the one-shot local opt-out; consumed
  // and cleared by `send` regardless of whether it was actually set.
  const [rounds, setRounds] = useState(0)
  const [askMoreNext, setAskMoreNext] = useState(false)
  const loaded = useRef(false)
  const listRef = useRef<HTMLDivElement>(null)

  // A background work unit owns the session: the composer is closed until the
  // draft lands (M25.5).
  const background = state === 'working' || state === 'queued'
  const sending = streaming !== null || background

  useEffect(() => {
    const off = window.somni.onChatEvent((ev: ChatEvent) => {
      if (ev.slug !== slug) return
      if (ev.kind === 'text') setStreaming((s) => (s ?? '') + ev.text)
      if (ev.kind === 'error') {
        setStreaming(null)
        setError(ev.message)
      }
      if (ev.kind === 'title') setName(ev.name)
      if (ev.kind === 'state') setState(ev.state)
      if (ev.kind === 'done') {
        setStreaming(null)
        setMessages((m) => [...m, ev.message])
        // Ask-more fix: a live event's question is what actually advances the
        // interview count — the mount-time loadChat snapshot never updates on
        // its own, so an uninterrupted interview crossing the cap without a
        // remount would otherwise never offer the bypass (the exact failure
        // this affordance exists to prevent).
        setRounds((r) => nextRounds(r, ev.question))
        // Single slot: only the latest turn's actionable card is shown.
        setProposal(ev.proposal)
        // Fix (M27 §7): a live turn's own provenance always wins over the
        // mount-time guess — a proposal from THIS turn is never stale.
        setFromWorkUnit(!!ev.workUnit)
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
    setState(null) // main clears the session state on every send (M25.3)
    const { opts, next } = consumeAskMore(askMoreNext)
    setAskMoreNext(next)
    const res = await window.somni.sendChat(repo, slug, text, opts)
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
      setMessages(c.messages)
      setRounds(c.questionRounds)
      // A Turn still in flight (M25.2): main replays what it has streamed so
      // far, so re-entering the view shows the partial reply, not an idle one.
      if (c.busy) setStreaming(c.partial)
      // Reopened brief (M27 §7 fix): a needs-review session gets no live
      // 'done' event to carry its proposal on this mount, so main replays it
      // from the transcript — but only when the session is STILL parked
      // needs-review at mount (ui.ts's shouldSeedProposal). Dismiss clears
      // groomState (session:reopen) while leaving the fence text sitting in
      // the transcript, so a dismissed proposal must never resurrect just
      // because it's still there (round-3 fix). `prev ?? c.proposal` also
      // never clobbers a live event that (impossibly fast, but just in case)
      // beat this load.
      if (shouldSeedProposal(c.proposal, groomState)) setProposal((prev) => prev ?? c.proposal)
      // The seed is the quick-start's first message. Each groom owns its own
      // transcript now, so a fresh one is always empty — but never re-send into
      // a transcript that already has turns.
      if (seed && c.messages.length === 0) void send(seed)
      // Owner mount-handoff (§5): only when there's no seed about to send —
      // a quick-started owner groom always carries one, and that first send is
      // what routes it into a work unit (chat.ts's birth handling).
      else if (
        shouldAutoHandoff(persona, c.messages.length, c.busy, state, itemName, item?.spec ?? '')
      )
        void window.somni.handoffSession(repo, slug)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per slug
  }, [repo, slug])

  // `queue`: true only on the needs-review Approve & run path — passes the
  // applied children through so App.tsx can compute the pipeline ids
  // (ui.ts's approveRunIds). Every other apply (inline interview, quick-start
  // auto-run) calls onApplied with just the item, exactly as before.
  const doApply = async (queue: boolean): Promise<void> => {
    if (!proposal) return
    setApplying(true)
    const res = await window.somni.applyProposal(repo, slug, proposal)
    if (!res.ok) {
      setApplying(false)
      setError(res.error)
      return
    }
    onApplied(res.item, queue ? res.children : undefined)
  }

  // Manual override of the AI auto-title. `prompt` matches the view's existing
  // `confirm` idiom — no modal component for one string.
  const rename = (): void => {
    const next = prompt('Rename this groom', name)?.trim()
    if (!next || next === name) return
    void window.somni.renameItem(repo, itemId, next).then((i) => setName(i.name))
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
    setRounds(0)
    setAskMoreNext(false)
  }

  const handoff = async (): Promise<void> => {
    setError(null)
    const res = await window.somni.handoffSession(repo, slug)
    if (!res.ok) setError(res.error ?? 'handoff failed')
  }

  const resume = async (): Promise<void> => {
    setError(null)
    const res = await window.somni.resumeSession(repo, slug)
    if (!res.ok) setError(res.error ?? 'resume failed')
  }

  // Dismissing the Proposal returns the session to plain conversation — the
  // needs-review flag is main's, so clear it there too (M25.5).
  const dismiss = (): void => {
    setProposal(null)
    setState(null)
    void window.somni.reopenSession(repo, slug)
  }

  const submit = (): void => {
    const text = input
    setInput('')
    void send(text)
  }

  // Header persona chip (§4): flips this groom only, via the same full-replace
  // item:save StoryPanel's Save uses — `item` carries every other field so
  // nothing else round-trips changed. No `item` yet (a groom opened this tick,
  // before the next repo refresh): the chip still shows the fallback, but
  // flipping is a no-op rather than risk writing a half-filled record.
  const flipPersona = (): void => {
    if (!item) return
    const next: Persona = persona === 'owner' ? 'director' : 'owner'
    setPersonaOverride(next)
    void window.somni.saveItem(repo, { ...item, persona: next })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-stack-gap">
      <div className="flex shrink-0 items-center gap-4 border-b border-border-subtle pb-4">
        <h2 className="truncate font-headline-md text-headline-md font-bold">
          {itemId} — {name}
        </h2>
        <button className={CHIP} onClick={flipPersona} title="Toggle who's grooming this">
          {persona === 'owner' ? 'Project Owner' : 'Technical Director'}
        </button>
        <button className={BTN_GHOST} onClick={rename}>
          Rename
        </button>
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
        {streaming !== null && <StreamingBubble text={streaming} />}
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
        <ProposalSection
          proposal={proposal}
          roles={roles}
          fromWorkUnit={fromWorkUnit}
          applying={applying}
          applyLabel={applyLabel}
          onApply={() => void doApply(false)}
          onApproveRun={() => void doApply(true)}
          onDismiss={dismiss}
        />
      )}
      {background && (
        <p className="shrink-0 rounded-lg bg-surface-container px-4 py-3 text-on-surface-variant">
          {state === 'working'
            ? 'Drafting in the background — resolving the open questions and writing a Proposal. You can leave this session.'
            : 'Queued — three sessions are already drafting; this one starts when a slot frees.'}
        </p>
      )}
      {/* Quit interrupted the background draft (M25.6); resuming continues the
          same conversation, so nothing said so far is lost. */}
      {state === 'interrupted' && (
        <p className="flex shrink-0 items-center gap-3 rounded-lg bg-surface-container px-4 py-3 text-on-surface-variant">
          Interrupted when somni quit — the conversation is intact.
          <button className={BTN_GHOST} onClick={() => void resume()}>
            Resume
          </button>
        </p>
      )}
      {/* Ask-more (M29 item 9): the interview cap otherwise routes the next
          answer straight into a background draft with no warning — this is
          the opt-out, spending one send's worth of `interactive: true`. */}
      {shouldOfferAskMore(rounds, sending, proposal !== null) && (
        <p className="flex shrink-0 items-center gap-3 rounded-lg bg-surface-container px-4 py-3 text-on-surface-variant">
          Three rounds in — the next answer drafts a proposal. Keep talking instead?
          <button className={BTN_GHOST} onClick={() => setAskMoreNext(true)}>
            Ask more questions
          </button>
        </p>
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
          <button
            className={BTN_GHOST}
            onClick={() => void send(window.somni.proposeNow)}
            disabled={sending}
          >
            Propose Now
          </button>
          <button className={BTN_GHOST} onClick={() => void handoff()} disabled={sending}>
            Draft in background
          </button>
          <MicButton
            disabled={sending}
            // Empty box: the transcription IS the reply — send it (M24).
            // A typed partial thought: append and wait, never auto-send mixed.
            onText={(text) =>
              input.trim() ? setInput((cur) => appendText(cur, text)) : void send(text)
            }
          />
        </div>
      </div>
    </div>
  )
}
