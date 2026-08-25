import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  slugify,
  ensureSomni,
  loadBacklog,
  loadRepo,
  saveBacklog,
  saveRole,
  deleteRole,
  saveWorkflow,
  deleteWorkflow,
  resolveProfile,
  resolveSettings,
  setSelected
} from './store'

let repo: string
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'somni-store-'))
})

describe('slugify', () => {
  it('normalizes names', () => {
    expect(slugify('Senior Developer!')).toBe('senior-developer')
    expect(slugify('  ')).toBe('untitled')
  })
})

describe('store round-trips', () => {
  it('bootstraps .somni/.gitignore once', () => {
    ensureSomni(repo)
    expect(readFileSync(join(repo, '.somni/.gitignore'), 'utf8')).toContain('runs/*/logs/')
  })

  it('saves and reloads roles and workflows', () => {
    const role = saveRole(repo, { slug: '', name: 'Senior Tester', preamble: 'You test things.' })
    expect(role.slug).toBe('senior-tester')
    const wf = saveWorkflow(repo, {
      slug: '',
      name: 'Add feature',
      selected: true,
      tasks: [{ title: 'Design', prompt: 'Design it', role: 'senior-tester', selected: true }]
    })
    const data = loadRepo(repo)
    expect(data.roles).toEqual([role])
    expect(data.workflows).toEqual([wf])
  })

  it('deletes files', () => {
    saveRole(repo, { slug: '', name: 'X', preamble: 'p' })
    deleteRole(repo, 'x')
    saveWorkflow(repo, { slug: '', name: 'Y', selected: false, tasks: [] })
    deleteWorkflow(repo, 'y')
    expect(loadRepo(repo)).toEqual({ roles: [], workflows: [], backlog: [] })
    expect(existsSync(join(repo, '.somni/roles/x.md'))).toBe(false)
  })

  it('picks up hand-edited files and survives malformed ones', () => {
    mkdirSync(join(repo, '.somni/workflows'), { recursive: true })
    writeFileSync(join(repo, '.somni/workflows/hand.json'), '{"name":"Hand","tasks":[]}')
    writeFileSync(join(repo, '.somni/workflows/broken.json'), 'not json')
    const data = loadRepo(repo)
    expect(data.workflows).toEqual([{ slug: 'hand', name: 'Hand', selected: false, tasks: [] }])
  })
})

describe('execution profile & settings resolution', () => {
  it('parses and round-trips role frontmatter', () => {
    mkdirSync(join(repo, '.somni/roles'), { recursive: true })
    writeFileSync(
      join(repo, '.somni/roles/dev.md'),
      '---\nmodel: opus\neffort: high\n---\n# Dev\n\nBe good.\n'
    )
    const role = loadRepo(repo).roles[0]
    expect(role).toEqual({
      slug: 'dev',
      name: 'Dev',
      preamble: 'Be good.',
      model: 'opus',
      effort: 'high'
    })
    saveRole(repo, role)
    expect(loadRepo(repo).roles[0]).toEqual(role)
  })

  it('omits the frontmatter fence when the overrides are cleared', () => {
    saveRole(repo, { slug: 'dev', name: 'Dev', preamble: 'p', model: '', effort: undefined })
    expect(readFileSync(join(repo, '.somni/roles/dev.md'), 'utf8')).toBe('# Dev\n\np\n')
    expect(loadRepo(repo).roles[0]).toEqual({ slug: 'dev', name: 'Dev', preamble: 'p' })
  })

  it('ignores unknown/invalid frontmatter keys', () => {
    mkdirSync(join(repo, '.somni/roles'), { recursive: true })
    writeFileSync(join(repo, '.somni/roles/x.md'), '---\neffort: turbo\nrunner: agy\n---\n# X\n')
    expect(loadRepo(repo).roles[0]).toEqual({ slug: 'x', name: 'X', preamble: '' })
  })

  it('resolves role over repo config over global', () => {
    mkdirSync(join(repo, '.somni'), { recursive: true })
    writeFileSync(join(repo, '.somni/config.json'), '{"model":"repo","concurrency":5}')
    const settings = resolveSettings(repo, { model: 'global', effort: 'low', timeoutMinutes: 10 })
    expect(settings).toMatchObject({
      model: 'repo',
      effort: 'low',
      concurrency: 5,
      timeoutMinutes: 10
    })
    expect(settings.reportStyle).toBe('minimal') // default
    expect(resolveProfile({ model: 'role' }, settings)).toEqual({
      runner: 'claude',
      model: 'role',
      effort: 'low'
    })
    expect(resolveProfile(undefined, settings)).toEqual({
      runner: 'claude',
      model: 'repo',
      effort: 'low'
    })
  })

  it('resolves the runner role → repo → global, defaulting to claude', () => {
    mkdirSync(join(repo, '.somni'), { recursive: true })
    writeFileSync(join(repo, '.somni/config.json'), '{"runner":"antigravity"}')
    const settings = resolveSettings(repo, { runner: 'claude' })
    expect(settings.runner).toBe('antigravity')
    expect(resolveProfile(undefined, settings).runner).toBe('antigravity')
    expect(resolveProfile({ runner: 'claude' }, settings).runner).toBe('claude')
    expect(resolveProfile(undefined, {}).runner).toBe('claude')
  })

  it('round-trips a runner override through role frontmatter', () => {
    saveRole(repo, { slug: 'dev', name: 'Dev', preamble: 'p', runner: 'antigravity' })
    expect(loadRepo(repo).roles[0].runner).toBe('antigravity')
  })
})

describe('setSelected', () => {
  it('flips only the tick, leaving tasks and the Brief sidecar untouched', () => {
    saveWorkflow(repo, {
      slug: '',
      name: 'Ship it',
      selected: false,
      brief: 'the why',
      tasks: [{ title: 'T', prompt: 'p', role: 'dev', selected: true }]
    })
    setSelected(repo, 'ship-it', true)
    const wf = loadRepo(repo).workflows[0]
    expect(wf.selected).toBe(true)
    expect(wf.tasks).toEqual([{ title: 'T', prompt: 'p', role: 'dev', selected: true }])
    expect(wf.brief).toBe('the why\n')
    setSelected(repo, 'ship-it', false)
    expect(loadRepo(repo).workflows[0].selected).toBe(false)
  })

  it('throws for a workflow that is not on disk (callers fail soft)', () => {
    expect(() => setSelected(repo, 'ghost', true)).toThrow()
  })
})

// repoIpc's backlog:promote and backlog:park handlers are thin compositions of
// these store functions (M9 Decision 4) — exercised here since the IPC layer
// itself needs an Electron mock to unit test.
describe('backlog promote/park (mirrors repoIpc composition)', () => {
  it('promote removes the slug from backlog and ticks its workflow', () => {
    saveWorkflow(repo, { slug: '', name: 'Ship it', selected: false, tasks: [] })
    saveWorkflow(repo, { slug: '', name: 'Other', selected: false, tasks: [] })
    saveBacklog(repo, ['ship-it', 'other'])
    saveBacklog(
      repo,
      loadBacklog(repo).filter((s) => s !== 'ship-it')
    )
    setSelected(repo, 'ship-it', true)
    expect(loadBacklog(repo)).toEqual(['other'])
    expect(loadRepo(repo).workflows.find((w) => w.slug === 'ship-it')?.selected).toBe(true)
  })

  it('park unticks the workflow and appends it to backlog', () => {
    saveWorkflow(repo, { slug: '', name: 'Ship it', selected: true, tasks: [] })
    setSelected(repo, 'ship-it', false)
    const backlog = loadBacklog(repo)
    saveBacklog(repo, [...backlog, 'ship-it'])
    expect(loadBacklog(repo)).toEqual(['ship-it'])
    expect(loadRepo(repo).workflows.find((w) => w.slug === 'ship-it')?.selected).toBe(false)
  })
})
