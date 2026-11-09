import { afterEach, describe, expect, it } from 'vitest'
import { DOWN_MS, candidates, isDown, markDown, resetHealth, opendata } from './index'
import { transitous } from './transitous'

const ZURICH = [47.378, 8.54] as const
const BERLIN = [52.52, 13.41] as const

describe('network failover', () => {
  afterEach(resetHealth)

  it('asks the network for the position first, then the others covering it', () => {
    expect(candidates('auto', ...ZURICH, 0)).toEqual([opendata, transitous])
    expect(candidates('auto', ...BERLIN, 0)).toEqual([transitous])
    expect(candidates('eu', ...ZURICH, 0)).toEqual([transitous, opendata])
  })

  it('puts a network that just failed last, and tries it first again after the pause', () => {
    markDown(opendata, 1000)
    expect(isDown(opendata, 1000)).toBe(true)
    expect(candidates('auto', ...ZURICH, 1000)).toEqual([transitous, opendata])
    expect(candidates('auto', ...ZURICH, 1000 + DOWN_MS + 1)).toEqual([opendata, transitous])
  })
})
