// Packaged .apps launched from Finder inherit launchd's bare PATH
// (/usr/bin:/bin:…), which hides Homebrew installs of whisper-cli and the
// runner CLIs — everything works in dev and dies in the DMG build. Resolve the
// login shell's PATH once at startup and assign it to process.env.PATH so every
// spawn (voice, runner, git) inherits it from one place.
import { execFileSync } from 'child_process'

const HOMEBREW_DIRS = ['/opt/homebrew/bin', '/usr/local/bin']
const MARKER = '__PATH__'

export function shellPath(
  shell = process.env.SHELL || '/bin/zsh',
  base = process.env.PATH || ''
): string {
  const fallback = [base, ...HOMEBREW_DIRS.filter((d) => !base.split(':').includes(d))]
    .filter(Boolean)
    .join(':')
  try {
    // -ilc: interactive login shell, so ~/.zprofile and ~/.zshrc PATH edits
    // apply. The marker survives any greeting noise rc files print.
    const out = execFileSync(shell, ['-ilc', `printf '${MARKER}%s' "$PATH"`], {
      timeout: 3000,
      encoding: 'utf8'
    })
    const found = out.match(/__PATH__([^\n]*)/)?.[1]
    return found || fallback
  } catch {
    return fallback
  }
}
