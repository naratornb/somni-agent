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

const marker = (): { version: number; methodology: string; dirs: string[] } =>
  JSON.parse(readFileSync(join(repo, '.claude', 'skills', '.somni-skills.json'), 'utf8'))

describe('skills injection', () => {
  it('bundles each methodology manifest with every skill pinned to a hash', () => {
    for (const [methodology, upstream, count] of [
      ['pocock', 'mattpocock/skills', 11],
      ['superpowers', 'obra/superpowers', 8]
    ] as const) {
      const m = loadManifest(methodology)
      expect(m.upstream).toBe(upstream)
      expect(Object.keys(m.skills)).toHaveLength(count)
      for (const [name, pin] of Object.entries(m.skills)) {
        expect(pin, name).toMatch(/^[0-9a-f]{40}$|^local$/)
        expect(
          existsSync(join(process.cwd(), 'resources', 'skills', methodology, name, 'SKILL.md')),
          `${methodology}/${name}`
        ).toBe(true)
      }
    }
  })

  it('writes the full set into a fresh repo and nothing else', () => {
    expect(skillsStatus(repo, 'pocock').repoVersion).toBe(null)

    injectSkills(repo, 'pocock')

    const m = loadManifest('pocock')
    for (const name of Object.keys(m.skills))
      expect(existsSync(join(repo, '.claude', 'skills', name, 'SKILL.md')), name).toBe(true)
    expect(marker().version).toBe(m.version)
    expect(marker().methodology).toBe('pocock')
    expect(marker().dirs).toEqual(Object.keys(m.skills))
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

    injectSkills(repo, 'pocock')

    expect(readFileSync(join(repo, 'CONTEXT.md'), 'utf8')).toBe('# Mine\n')
    expect(readFileSync(join(repo, '.claude', 'skills', 'custom', 'SKILL.md'), 'utf8')).toBe(
      'mine too\n'
    )
  })

  it('is idempotent, and reports the three status states truthfully', () => {
    const bundled = loadManifest('pocock').version
    expect(skillsStatus(repo, 'pocock')).toEqual({ bundledVersion: bundled, repoVersion: null })

    injectSkills(repo, 'pocock')
    const first = readFileSync(join(repo, '.claude', 'skills', 'tdd', 'SKILL.md'), 'utf8')
    expect(skillsStatus(repo, 'pocock')).toEqual({ bundledVersion: bundled, repoVersion: bundled })

    injectSkills(repo, 'pocock')
    expect(readFileSync(join(repo, '.claude', 'skills', 'tdd', 'SKILL.md'), 'utf8')).toBe(first)

    // A stale repo (older marker) is the upgrade offer; injecting refreshes it.
    // Version-only markers are the pre-methodology format: they read as pocock.
    writeFileSync(
      join(repo, '.claude', 'skills', '.somni-skills.json'),
      JSON.stringify({ version: bundled - 1 })
    )
    writeFileSync(join(repo, '.claude', 'skills', 'tdd', 'SKILL.md'), 'stale\n')
    expect(skillsStatus(repo, 'pocock').repoVersion).toBe(bundled - 1)

    injectSkills(repo, 'pocock')
    expect(readFileSync(join(repo, '.claude', 'skills', 'tdd', 'SKILL.md'), 'utf8')).toBe(first)
    expect(marker().version).toBe(bundled)
  })

  it('switching methodology swaps the somni set and spares user skills', () => {
    mkdirSync(join(repo, '.claude', 'skills', 'custom'), { recursive: true })
    writeFileSync(join(repo, '.claude', 'skills', 'custom', 'SKILL.md'), 'mine\n')
    injectSkills(repo, 'pocock')

    // The other methodology's bundle reads as "not set up", never "upgrade".
    expect(skillsStatus(repo, 'superpowers').repoVersion).toBe(null)

    injectSkills(repo, 'superpowers')

    for (const name of Object.keys(loadManifest('pocock').skills))
      expect(existsSync(join(repo, '.claude', 'skills', name)), name).toBe(false)
    for (const name of Object.keys(loadManifest('superpowers').skills))
      expect(existsSync(join(repo, '.claude', 'skills', name, 'SKILL.md')), name).toBe(true)
    expect(readFileSync(join(repo, '.claude', 'skills', 'custom', 'SKILL.md'), 'utf8')).toBe(
      'mine\n'
    )
    expect(marker().methodology).toBe('superpowers')
    expect(skillsStatus(repo, 'pocock').repoVersion).toBe(null)

    // A legacy version-only marker (pocock install) is cleaned up the same way.
    injectSkills(repo, 'pocock')
    writeFileSync(
      join(repo, '.claude', 'skills', '.somni-skills.json'),
      JSON.stringify({ version: 1 })
    )
    injectSkills(repo, 'superpowers')
    expect(existsSync(join(repo, '.claude', 'skills', 'tdd'))).toBe(false)
    expect(existsSync(join(repo, '.claude', 'skills', 'test-driven-development'))).toBe(true)
  })
})
