import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { SkillsMPSkill } from '../src/types/skills'

const { search } = vi.hoisted(() => ({ search: vi.fn() }))

vi.mock('../src/lib/ipc-client', () => ({ ipc: { skillsSearch: search } }))
vi.mock('../src/lib/shared-storage', () => ({
  sharedStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}))

import { useSkillsStore } from '../src/stores/skills-store'

const skill = (id: string): SkillsMPSkill => ({
  id, name: `Skill ${id}`, author: 'Author', description: 'Description', skillUrl: 'https://example.test/skill',
  downloadUrl: 'https://example.test/download', githubUrl: 'https://example.test/download', stars: 1, updatedAt: '',
})

const response = (skills: SkillsMPSkill[] = [], page = 1, hasNext = false) => JSON.stringify({
  success: true,
  data: { skills, pagination: { page, limit: 20, total: skills.length, totalPages: hasNext ? page + 1 : page, hasNext, hasPrev: page > 1 } },
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((success, failure) => { resolve = success; reject = failure })
  return { promise, resolve, reject }
}

beforeEach(() => {
  search.mockReset()
  useSkillsStore.getState().clearSearch()
  useSkillsStore.setState({ recommendedSkills: [], recommendedLoading: false, recommendedError: null })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => vi.restoreAllMocks())

describe('skills marketplace request feedback', () => {
  it('distinguishes an empty successful search from a failed request and clears errors on retry', async () => {
    search.mockRejectedValueOnce(new Error('Network offline')).mockResolvedValueOnce(response())
    await useSkillsStore.getState().searchOnlineSkills('nothing')
    expect(useSkillsStore.getState()).toMatchObject({ searchError: 'Network offline', searchLoading: false, searchResults: [] })
    const retry = useSkillsStore.getState().searchOnlineSkills('nothing')
    expect(useSkillsStore.getState().searchError).toBeNull()
    await retry
    expect(useSkillsStore.getState()).toMatchObject({ searchError: null, searchLoading: false, searchResults: [], searchTotal: 0 })
  })

  it('surfaces service errors instead of showing a false empty result', async () => {
    search.mockResolvedValueOnce(JSON.stringify({ success: false, error: { message: 'Service unavailable' } }))
    await useSkillsStore.getState().searchOnlineSkills('test')
    expect(useSkillsStore.getState().searchError).toBe('Service unavailable')
    expect(useSkillsStore.getState().searchLoading).toBe(false)
  })

  it('keeps a visible failure state for malformed responses and errors without a message', async () => {
    search.mockResolvedValueOnce('not-json').mockRejectedValueOnce(new Error())
    await useSkillsStore.getState().searchOnlineSkills('test')
    expect(useSkillsStore.getState().searchError).toBeTruthy()
    await useSkillsStore.getState().loadRecommended()
    expect(useSkillsStore.getState().recommendedError).toBe('MARKET_REQUEST_FAILED')
  })

  it('keeps existing results and page when loading the next page fails, so retry loads the same page', async () => {
    search.mockResolvedValueOnce(response([skill('first')], 1, true)).mockRejectedValueOnce(new Error('Timeout')).mockResolvedValueOnce(response([skill('second')], 2))
    await useSkillsStore.getState().searchOnlineSkills('test')
    await useSkillsStore.getState().searchOnlineSkills('test', 2)
    expect(useSkillsStore.getState()).toMatchObject({ searchPage: 1, searchHasNext: true, searchError: 'Timeout' })
    expect(useSkillsStore.getState().searchResults.map((entry) => entry.id)).toEqual(['first'])
    await useSkillsStore.getState().searchOnlineSkills('test', 2)
    expect(useSkillsStore.getState().searchResults.map((entry) => entry.id)).toEqual(['first', 'second'])
    expect(useSkillsStore.getState()).toMatchObject({ searchPage: 2, searchError: null, searchLoading: false })
  })

  it('ignores late success and failure from superseded searches', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    search.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockResolvedValueOnce(response([skill('latest')]))
    const oldSuccess = useSkillsStore.getState().searchOnlineSkills('old-success')
    const oldFailure = useSkillsStore.getState().searchOnlineSkills('old-failure')
    await useSkillsStore.getState().searchOnlineSkills('latest')
    first.resolve(response([skill('stale')]))
    second.reject(new Error('Stale failure'))
    await Promise.all([oldSuccess, oldFailure])
    expect(useSkillsStore.getState()).toMatchObject({ searchQuery: 'latest', searchError: null, searchLoading: false })
    expect(useSkillsStore.getState().searchResults.map((entry) => entry.id)).toEqual(['latest'])
  })

  it('does not repopulate cleared searches when an earlier request completes', async () => {
    const pending = deferred<string>()
    search.mockReturnValueOnce(pending.promise)
    const request = useSkillsStore.getState().searchOnlineSkills('old')
    useSkillsStore.getState().clearSearch()
    pending.resolve(response([skill('old')]))
    await request
    expect(useSkillsStore.getState()).toMatchObject({ searchQuery: '', searchResults: [], searchLoading: false, searchError: null })
  })

  it('distinguishes recommendation failures from empty recommendations and retries successfully', async () => {
    search.mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce(response())
    await useSkillsStore.getState().loadRecommended()
    expect(useSkillsStore.getState()).toMatchObject({ recommendedError: 'Offline', recommendedLoading: false, recommendedSkills: [] })
    await useSkillsStore.getState().loadRecommended()
    expect(useSkillsStore.getState()).toMatchObject({ recommendedError: null, recommendedLoading: false, recommendedSkills: [] })
    expect(search).toHaveBeenLastCalledWith('', 1, 12)
  })

  it('preserves cached recommendations on refresh failure and ignores an older recommendation response', async () => {
    useSkillsStore.setState({ recommendedSkills: [skill('cached')] })
    search.mockRejectedValueOnce(new Error('Offline'))
    await useSkillsStore.getState().loadRecommended()
    expect(useSkillsStore.getState().recommendedSkills.map((entry) => entry.id)).toEqual(['cached'])
    const old = deferred<string>()
    search.mockReturnValueOnce(old.promise).mockResolvedValueOnce(response([skill('new')]))
    const oldRequest = useSkillsStore.getState().loadRecommended()
    await useSkillsStore.getState().loadRecommended()
    old.resolve(response([skill('stale')]))
    await oldRequest
    expect(useSkillsStore.getState().recommendedSkills.map((entry) => entry.id)).toEqual(['new'])
    expect(useSkillsStore.getState()).toMatchObject({ recommendedError: null, recommendedLoading: false })
  })
})
