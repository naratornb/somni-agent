// Pieces shared by the two drafting surfaces (§7): the Draft view and the
// workflow editor's chat panel. Rendering only — every decision is main's.
import type { ChatProposal, ChatQuestion, Role } from '../../preload/index'

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
    <div className="question-card">
      <p>{q.question}</p>
      <div className="row wrap">
        {q.options.map((opt) => (
          <button
            key={opt}
            className={opt === q.recommended ? 'chip recommended' : 'chip'}
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
    <div className="proposal-pane">
      <span className="dim">
        Proposed workflow — {plural(proposal.tasks.length, 'task')}
        {proposal.roles.length ? `, ${plural(proposal.roles.length, 'new role')}` : ''}
      </span>
      {proposal.brief && (
        <details className="brief-box">
          <summary>Brief</summary>
          <p className="dim brief-text">{proposal.brief}</p>
        </details>
      )}
      {proposal.tasks.map((t, i) => (
        <div className="task-card proposed" key={i}>
          <div className="row">
            <b>{t.title}</b>
            {t.role && <span className="chip">{t.role}</span>}
          </div>
          <span className="dim">{t.prompt}</span>
        </div>
      ))}
      {proposal.roles.map((r) => (
        <div className="task-card" key={r.slug}>
          <div className="row">
            <b>{r.name}</b>
            <span className="chip">{r.slug}</span>
            {existing.has(r.slug) && <span className="chip skip">already exists — will reuse</span>}
          </div>
          <span className="dim">{r.preamble}</span>
        </div>
      ))}
      <div className="row">
        <button onClick={onApply} disabled={disabled}>
          {applyLabel}
        </button>
        <button className="ghost" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  )
}
