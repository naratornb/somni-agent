// Injection is the §10 risk: it writes into repos somni doesn't own. These
// tests pin the write-set — what lands, and just as importantly what doesn't.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
  ipcMain: { handle: () => {} }
}))

const { injectSkills, loadManifest, skillsStatus } = await import('./skills')

let repo: string

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'somni-skills-'))
})
afterEach(() => rmSync(repo, { recursive: true, force: true }))

const marker = (): { version: number } =>
  JSON.parse(readFileSync(join(repo, '.claude', 'skills', '.somni-skills.json'), 'utf8'))

describe('skills injection', () => {
  it('bundles exactly the 11 manifest skills, each pinned to a hash', () => {
    const m = loadManifest()
    expect(m.upstream).toBe('mattpocock/skills')
    expect(Object.keys(m.skills)).toHaveLength(11)
    for (const [name, pin] of Object.entries(m.skills)) {
      expect(pin, name).toMatch(/^[0-9a-f]{40}$|^local$/)
      expect(existsSync(join(process.cwd(), 'resources', 'skills', name, 'SKILL.md')), name).toBe(
        true
      )
    }
  })

  it('writes the full set into a fresh repo and nothing else', () => {
    expect(skillsStatus(repo).repoVersion).toBe(null)

    injectSkills(repo)

    const m = loadManifest()
    for (const name of Object.keys(m.skills))
      expect(existsSync(join(repo, '.claude', 'skills', name, 'SKILL.md')), name).toBe(true)
    expect(marker().version).toBe(m.version)
    expect(readFileSync(join(repo, 'docs', 'agents', 'issue-tracker.md'), 'utf8')).toContain(
      '.somni/items/'
    )
    expect(existsSync(join(repo, 'docs', 'adr'))).toBe(true)
    expect(readFileSync(join(repo, 'CONTEXT.md'), 'utf8')).toContain('Stubbed by somni')
    // Top level: only the three roots the brief allows.
    expect(new Set(readdirSync(repo))).toEqual(new Set(['.claude', 'docs', 'CONTEXT.md']))
  })

  it('never touches an existing CONTEXT.md or a user-authored skill', () => {
    writeFileSync(join(repo, 'CONTEXT.md'), '# Mine\n')
    mkdirSync(join(repo, '.claude', 'skills', 'custom'), { recursive: true })
    writeFileSync(join(repo, '.claude', 'skills', 'custom', 'SKILL.md'), 'mine too\n')

    injectSkills(repo)

    expect(readFileSync(join(repo, 'CONTEXT.md'), 'utf8')).toBe('# Mine\n')
    expect(readFileSync(join(repo, '.claude', 'skills', 'custom', 'SKILL.md'), 'utf8')).toBe(
      'mine too\n'
    )
  })

  it('is idempotent, and reports the three status states truthfully', () => {
    const bundled = loadManifest().version
    expect(skillsStatus(repo)).toEqual({ bundledVersion: bundled, repoVersion: null })

    injectSkills(repo)
    const first = readFileSync(join(repo, '.claude', 'skills', 'tdd', 'SKILL.md'), 'utf8')
    expect(skillsStatus(repo)).toEqual({ bundledVersion: bundled, repoVersion: bundled })

    injectSkills(repo)
    expect(readFileSync(join(repo, '.claude', 'skills', 'tdd', 'SKILL.md'), 'utf8')).toBe(first)

    // A stale repo (older marker) is the upgrade offer; injecting refreshes it.
    writeFileSync(
      join(repo, '.claude', 'skills', '.somni-skills.json'),
      JSON.stringify({ version: bundled - 1 })
    )
    writeFileSync(join(repo, '.claude', 'skills', 'tdd', 'SKILL.md'), 'stale\n')
    expect(skillsStatus(repo).repoVersion).toBe(bundled - 1)

    injectSkills(repo)
    expect(readFileSync(join(repo, '.claude', 'skills', 'tdd', 'SKILL.md'), 'utf8')).toBe(first)
    expect(marker().version).toBe(bundled)
  })
})
