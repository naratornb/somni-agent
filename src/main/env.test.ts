import { chmodSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { shellPath } from './env'

const fakeShell = (script: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'somni-env-'))
  const path = join(dir, 'shell')
  writeFileSync(path, `#!/bin/sh\n${script}\n`)
  chmodSync(path, 0o755)
  return path
}

describe('shellPath', () => {
  it('returns the login shell PATH found after the marker', () => {
    const shell = fakeShell(`printf '__PATH__/fake/bin:/usr/bin'`)
    expect(shellPath(shell, '/usr/bin')).toBe('/fake/bin:/usr/bin')
  })

  it('ignores rc-file noise printed before the marker', () => {
    const shell = fakeShell(`echo "welcome to zsh"\nprintf '__PATH__/quiet/bin'`)
    expect(shellPath(shell, '/usr/bin')).toBe('/quiet/bin')
  })

  it('falls back to base + homebrew dirs when the shell fails', () => {
    const shell = fakeShell('exit 1')
    expect(shellPath(shell, '/usr/bin:/bin')).toBe('/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin')
  })

  it('falls back when the shell prints no marker', () => {
    const shell = fakeShell(`printf 'nothing useful'`)
    const out = shellPath(shell, '/usr/bin')
    expect(out).toContain('/usr/bin')
    expect(out).toContain('/opt/homebrew/bin')
  })

  it('does not duplicate homebrew dirs already on the base PATH', () => {
    const shell = fakeShell('exit 1')
    expect(shellPath(shell, '/opt/homebrew/bin:/usr/bin')).toBe(
      '/opt/homebrew/bin:/usr/bin:/usr/local/bin'
    )
  })
})
