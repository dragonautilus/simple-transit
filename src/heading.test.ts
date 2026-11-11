import { describe, expect, it } from 'vitest'
import { angleDiff, axisHeading, bodyAxis, isFlat, orientationOf, phoneHeading, rotationMatrix, smoothVector } from './heading'

const ev = (o: Partial<Parameters<typeof orientationOf>[0]>) => ({ alpha: null, beta: 0, gamma: 0, absolute: false, type: 'deviceorientation', ...o })

describe('heading', () => {
  it('measures angles across north', () => {
    expect(angleDiff(350, 10)).toBe(20)
    expect(angleDiff(10, 350)).toBe(20)
    expect(angleDiff(0, 180)).toBe(180)
    expect(angleDiff(-90, 270)).toBe(0)
  })

  it('averages directions across north instead of through south', () => {
    let v = smoothVector(null, 350, 0.5)
    v = smoothVector(v, 10, 0.5)
    const deg = ((Math.atan2(v.x, v.y) * 180) / Math.PI + 360) % 360
    expect(angleDiff(deg, 0)).toBeLessThan(6)
  })

  it('uses the top of a flat phone', () => {
    // alpha counts counter-clockwise: 90 means the top points west
    const m = rotationMatrix(90, 5, -3)
    expect(isFlat(m)).toBe(true)
    expect(angleDiff(phoneHeading(m)!, 270)).toBeLessThan(6)
  })

  it('uses the back of an upright phone', () => {
    const m = rotationMatrix(0, 90, 0)
    expect(isFlat(m)).toBe(false)
    expect(angleDiff(phoneHeading(m)!, 0)).toBeLessThan(0.01)
  })

  it('follows your body with the axis learnt while walking', () => {
    // Phone upright and askew in a pocket, walking south-east
    const walking = rotationMatrix(200, 80, 25)
    const axis = bodyAxis(walking, 120)
    expect(angleDiff(axisHeading(walking, axis)!, 120)).toBeLessThan(0.01)
    // Turning 30° to the left on the spot turns the phone with you
    const turned = rotationMatrix(230, 80, 25)
    expect(angleDiff(axisHeading(turned, axis)!, 90)).toBeLessThan(0.01)
  })

  it('reads the iOS and Android compass', () => {
    expect(angleDiff(phoneHeading(orientationOf(ev({ webkitCompassHeading: 75 }))!)!, 75)).toBeLessThan(0.01)
    expect(angleDiff(phoneHeading(orientationOf(ev({ alpha: 90, type: 'deviceorientationabsolute' }))!)!, 270)).toBeLessThan(0.01)
    // Relative (not north-based) Android events don't count
    expect(orientationOf(ev({ alpha: 90 }))).toBeNull()
  })
})
