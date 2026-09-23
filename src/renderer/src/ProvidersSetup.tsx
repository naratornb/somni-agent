import type { ProviderHealth, RunnerName } from '../../preload/index'
import { BTN_PRIMARY } from './ui'

// Install/login guidance per provider (M26 §3) — pinned by the same sources as
// runners.ts's adapters (each CLI's own docs); update alongside a new adapter.
const GUIDES: Record<RunnerName, { install: string; login: string; docs: string }> = {
  claude: {
    install: 'npm install -g @anthropic-ai/claude-code',
    login: 'claude  (then /login)',
    docs: 'https://docs.anthropic.com/en/docs/claude-code'
  },
  codex: {
    install: 'npm install -g @openai/codex',
    login: 'codex login',
    docs: 'https://developers.openai.com/codex/cli'
  },
  gemini: {
    install: 'npm install -g @google/gemini-cli',
    login: 'gemini  (first run signs in)',
    docs: 'https://github.com/google-gemini/gemini-cli'
  },
  antigravity: {
    install: 'see docs',
    login: 'agy login',
    docs: 'https://antigravity.google/docs/cli'
  }
}

const NAMES: Record<RunnerName, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
  antigravity: 'Antigravity'
}

// Full-pane guided setup shown in place of the whole app when every provider
// probe fails — nothing can run without at least one (spec §3). Replaces the
// dismissible missing-runner banner rather than layering under it.
export function ProvidersSetup({
  health,
  onRecheck
}: {
  health: ProviderHealth[]
  onRecheck: () => void
}): React.JSX.Element {
  return (
    <div className="m-auto flex max-w-2xl flex-col gap-6 py-12">
      <div className="text-center">
        <h2 className="font-headline-lg text-headline-lg font-bold">Set up a provider</h2>
        <p className="mt-2 leading-relaxed text-on-surface-variant">
          somni runs your stories through a coding CLI — install and sign in to at least one to get
          started.
        </p>
      </div>
      <div className="flex flex-col gap-4">
        {health.map((h) => {
          const guide = GUIDES[h.name]
          return (
            <div
              key={h.name}
              className="flex flex-col gap-2 rounded-lg border border-border-subtle bg-surface-elevated p-card-padding"
            >
              <div className="flex items-center justify-between">
                <span className="font-semibold">{NAMES[h.name]}</span>
                {h.ok ? (
                  <span className="text-status-completed">{h.version ?? 'ok'}</span>
                ) : (
                  <span className="text-on-surface-variant">Not found</span>
                )}
              </div>
              {!h.ok && (
                <div className="flex flex-col gap-1 text-sm text-on-surface-variant">
                  <span>
                    Install: <code className="font-mono-code">{guide.install}</code>
                  </span>
                  <span>
                    Sign in: <code className="font-mono-code">{guide.login}</code>
                  </span>
                  <a
                    className="text-primary hover:underline"
                    href={guide.docs}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {guide.docs}
                  </a>
                </div>
              )}
            </div>
          )
        })}
      </div>
      <button className={`${BTN_PRIMARY} self-center`} onClick={onRecheck}>
        Check again
      </button>
    </div>
  )
}
