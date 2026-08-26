// Pieces shared by the two drafting surfaces (§7): the Draft view and the
// workflow editor's chat panel. Rendering only — every decision is main's.
import type { ChatProposal, ChatQuestion, Role } from '../../preload/index'
import { BTN_GHOST, BTN_PRIMARY, CHIP, STATUS_CHIP, STATUS_CHIP_BASE } from './ui'

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
        Proposed workflow — {plural(proposal.tasks.length, 'task')}
        {proposal.roles.length ? `, ${plural(proposal.roles.length, 'new role')}` : ''}
      </span>
      {proposal.brief && (
        // Left-accent border marks the read-only source of truth (DESIGN.md).
        <details className="overflow-hidden rounded-lg border border-l-2 border-border-subtle border-l-primary-container bg-surface">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-on-surface-variant hover:text-on-surface">
            Brief
          </summary>
          <p className="px-4 pb-3 text-sm whitespace-pre-wrap text-on-surface-variant">
            {proposal.brief}
          </p>
        </details>
      )}
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
