import { describe, expect, it } from 'vitest'
import { buildTrip } from '../journey'
import { boardRows, connectionItem, fitBytes, shortStop, tripSteps } from '../format'
import { estimateProgress } from '../journey'
import { cleanTrack, connectionsFromPlan, lineParts, locationsFromGeocode, nearbyFromMapStops, stationboardFromStopTimes } from './transitous'
import { NETWORKS, networkFor, swiss } from '.'
import plan from '../__fixtures__/transitous-plan.json'
import longPlan from '../__fixtures__/transitous-plan-long.json'
import stopTimes from '../__fixtures__/transitous-stoptimes.json'
import mapStops from '../__fixtures__/transitous-stops.json'

describe('Transitous adapter', () => {
  it('maps departures to board rows with line, destination and platform', () => {
    const entries = stationboardFromStopTimes(stopTimes as never)
    expect(entries.length).toBeGreaterThan(0)
    const first = entries[0]
    expect(first.to).toBe('S+U Berlin Hauptbahnhof')
    expect(first.stop.platform).toBe('1')
    const rows = boardRows(entries, 'S+U Alexanderplatz Bhf (Berlin)', Date.parse('2026-11-03T15:40:00Z'), 7)
    expect(rows[0].line).toBe('U5')
    expect(rows[0].dest).toBe('→ S+U Berlin Hauptbahnhof')
  })

  it('turns an itinerary into a trip with walks, rides and changes', () => {
    const conns = connectionsFromPlan(plan as never, 'Office')
    expect(conns.length).toBeGreaterThan(0)
    const trip = buildTrip(conns[0])
    const kinds = trip.legs.map((l) => l.kind)
    expect(kinds[0]).toBe('walk')
    const rides = trip.legs.filter((l) => l.kind === 'ride')
    expect(rides.map((r) => r.line)).toEqual(['S3', 'S2'])
    expect(rides[0].stops.length).toBeGreaterThan(2)
    expect(trip.legs[0].from.name).toBe('Start')
    expect(trip.end).toBeGreaterThan(trip.start)
    // Signature must be stable and distinct per ride (used to find the trip again on refresh)
    expect(trip.signature).toContain('S3')
    const steps = tripSteps(trip, estimateProgress(trip, trip.start, null)).lines.join('\n')
    expect(steps).toContain('Change at S+U Friedrichstr. Bhf (')
    expect(steps).toContain('walk 2')
    expect(steps).not.toContain('Walk 2')
    expect(steps).toContain('S2 → S Blankenfelde (TF) Bhf')
    expect(steps).toContain('S Südkreuz Bhf')
  })

  it('names lines like the Swiss board', () => {
    expect(lineParts('BUS', '100')).toEqual({ category: 'B', number: '100' })
    expect(lineParts('BUS', 'Bus 100')).toEqual({ category: 'B', number: '100' })
    expect(lineParts('TRAM', 'M10')).toEqual({ category: 'T', number: 'M10' })
    expect(lineParts('SUBWAY', 'U5')).toEqual({ category: 'U5', number: null })
    expect(lineParts('HIGHSPEED_RAIL', 'ICE 1234')).toEqual({ category: 'ICE', number: null })
    expect(lineParts('LONG_DISTANCE', 'TGV Lyria 9226')).toEqual({ category: 'TGV Lyria', number: null })
    expect(lineParts('HIGHSPEED_RAIL', 'ICE 70')).toEqual({ category: 'ICE 70', number: null })
  })

  it('shortens platforms', () => {
    expect(cleanTrack('1 (U5)')).toBe('1')
    expect(cleanTrack('Pos. 13')).toBe('13')
    expect(cleanTrack('12')).toBe('12')
    expect(cleanTrack(undefined)).toBeNull()
  })

  it('sorts nearby stops by distance and drops duplicate names', () => {
    const near = nearbyFromMapStops([...(mapStops as never[]), ...(mapStops as never[])], 52.5208, 13.4095, 6)
    expect(near.length).toBe(2)
    expect(near[0].distance!).toBeLessThan(near[1].distance!)
    expect(near[0].id).toBeTruthy()
  })

  it('maps geocoder results', () => {
    const [stop, addr] = locationsFromGeocode([
      { type: 'STOP', name: 'Berlin Hbf', id: 'x', lat: 52.5, lon: 13.3, areas: [{ name: 'Berlin', default: true }] },
      { type: 'ADDRESS', name: 'Unter den Linden 1', street: 'Unter den Linden', houseNumber: '1', id: 'a', lat: 52.5, lon: 13.4, areas: [{ name: 'Berlin', default: true }] },
    ])
    expect(stop.id).toBe('x')
    expect(addr.id).toBeNull()
    expect(addr.name).toBe('Unter den Linden 1, Berlin')
  })
})

describe('long journeys (Wallisellen → Hamburg)', () => {
  it('fit every connection list item into the 64-byte limit of the glasses', () => {
    const items = connectionsFromPlan(longPlan as never, 'Eimsbüttel').map((c) => fitBytes(connectionItem(buildTrip(c)), 60))
    expect(items.length).toBe(5)
    for (const item of items) expect(new TextEncoder().encode(item).length).toBeLessThanOrEqual(60)
    expect(items.join('\n')).not.toContain('9226')
  })

  it('cut by bytes, not characters', () => {
    expect(fitBytes('short', 60)).toBe('short')
    const cut = fitBytes('→'.repeat(30), 60)
    expect(new TextEncoder().encode(cut).length).toBeLessThanOrEqual(60)
    expect(cut.endsWith('…')).toBe(true)
  })
})

describe('networks', () => {
  it('selects Switzerland inside the country and Transitous elsewhere', () => {
    expect(networkFor('auto', 47.3782, 8.5402)).toBe(swiss)
    expect(networkFor('auto', 52.52, 13.4).id).toBe('eu')
    expect(networkFor('eu', 47.3782, 8.5402).id).toBe('eu')
    expect(NETWORKS.map((n) => n.id)).toEqual(['ch', 'eu'])
  })

  it('drops a same-town suffix from stop names', () => {
    expect(shortStop('S+U Berlin Hauptbahnhof (Berlin)', 'S+U Alexanderplatz Bhf (Berlin)')).toBe('S+U Berlin Hauptbahnhof')
    expect(shortStop('S Erkner Bhf (Erkner)', 'S+U Alexanderplatz Bhf (Berlin)')).toBe('S Erkner Bhf (Erkner)')
    expect(shortStop('Zürich, Central', 'Zürich HB')).toBe('Central')
  })
})
