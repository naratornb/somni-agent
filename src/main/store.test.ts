import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  slugify,
  ensureSomni,
  loadRepo,
  saveRole,
  deleteRole,
  saveWorkflow,
  deleteWorkflow,
  resolveProfile,
  resolveSettings
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
    expect(loadRepo(repo)).toEqual({ roles: [], workflows: [] })
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
    expect(resolveProfile({ model: 'role' }, settings)).toEqual({ model: 'role', effort: 'low' })
    expect(resolveProfile(undefined, settings)).toEqual({ model: 'repo', effort: 'low' })
  })
})
