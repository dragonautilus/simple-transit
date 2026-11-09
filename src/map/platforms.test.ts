import { describe, expect, it } from 'vitest'
import type { Location, StationboardEntry } from '../api'
import type { TStopTime } from '../networks/transitous'
import { boardRows } from '../format'
import { assignPlatforms, matchStops, platformTable, swissPosition, transitousPosition } from './platforms'

// Zürich, Löwenplatz: platform ::0 on the east side of Löwenstrasse, ::1 on the west side
const EAST = { lat: 47.376076, lon: 8.537472 }
const WEST = { lat: 47.37584, lon: 8.537167 }

/** Swiss departure as transport.opendata.ch returns it: no platform, the stop's single point. */
function swissEntry(category: string, number: string, to: string, departure = '2026-11-09T12:00:00+0100'): StationboardEntry {
  return {
    stop: { station: { id: '8591262', name: 'Zürich, Löwenplatz', coordinate: { x: 47.375895, y: 8.537418 } }, arrival: null, departure, platform: null },
    name: `${category} ${number}`,
    category,
    number,
    operator: null,
    to,
  }
}

/** Departure sample from Transitous /api/v6/stoptimes for the same stop (2026-11-09). */
function stopTime(line: string, headsign: string, at: { lat: number; lon: number }, track?: string): TStopTime {
  return { place: { name: 'Zürich, Löwenplatz', ...at, track }, mode: 'TRAM', realTime: true, routeShortName: line, headsign }
}

const sample = [
  stopTime('31', 'Zürich, Kienastenwies', EAST),
  stopTime('3', 'Zürich, Albisrieden', WEST),
  stopTime('14', 'Zürich, Bahnhofplatz/HB', EAST),
  stopTime('14', 'Zürich, Triemli', WEST),
  stopTime('3', 'Zürich, Klusplatz', EAST),
  stopTime('31', 'Zürich, Hermetschloo', WEST),
]

describe('Swiss stop platforms', () => {
  const table = platformTable(sample)
  const board = [
    swissEntry('T', '14', 'Zürich, Bahnhofplatz/HB'),
    swissEntry('B', '31', 'Zürich, Hermetschloo'),
    swissEntry('T', '3', 'Zürich, Klusplatz'),
    swissEntry('T', '14', 'Zürich, Triemli'),
  ]

  it('finds the platform of each departure by line and destination', () => {
    expect(swissPosition(table, board[0])).toMatchObject({ lat: EAST.lat, lng: EAST.lon })
    expect(swissPosition(table, board[1])).toMatchObject({ lat: WEST.lat, lng: WEST.lon })
    expect(swissPosition(table, swissEntry('T', '9', 'Zürich, Hirzenbach'))).toBeNull()
  })

  it('labels the platforms A, B west to east, and the rows with them', () => {
    const info = assignPlatforms(board, (e) => swissPosition(table, e))!
    expect(info.markers).toEqual([
      { lat: WEST.lat, lng: WEST.lon, label: 'A' },
      { lat: EAST.lat, lng: EAST.lon, label: 'B' },
    ])
    expect(board.map((e) => info.labelOf.get(e))).toEqual(['B', 'A', 'B', 'A'])
    const rows = boardRows(board, 'Zürich, Löwenplatz', Date.parse('2026-11-09T11:58:00+01:00'), 7, 23, info.labelOf)
    expect(rows.map((r) => r.info)).toEqual(['B', 'A', 'B', 'A'])
  })

  it('adds no markers when the shown departures all leave from one platform', () => {
    expect(assignPlatforms([board[0], board[2]], (e) => swissPosition(table, e))).toBeNull()
  })

  it('matches Swiss stops to Transitous stops by name and position', () => {
    const stations: Location[] = [
      { id: '8591262', name: 'Zürich, Löwenplatz', coordinate: { x: 47.375895, y: 8.537418 } },
      { id: '8591367', name: 'Zürich, Sihlpost/HB', coordinate: { x: 47.376096, y: 8.534202 } },
    ]
    const ids = matchStops(stations, [
      { name: 'Zürich, Löwenplatz', stopId: 'ch_Parentch:1:sloid:91262', lat: 47.375896, lon: 8.537417 },
      // Same name, but elsewhere
      { name: 'Zürich, Sihlpost/HB', stopId: 'other', lat: 47.39, lon: 8.534202 },
    ])
    expect(ids.get('8591262')).toBe('ch_Parentch:1:sloid:91262')
    expect(ids.get('8591367')).toBeNull()
  })
})

describe('Transitous stop platforms', () => {
  const entry = (lat: number, lng: number, platform: string | null): StationboardEntry => ({
    stop: { station: { id: 'x', name: 'Grunerstr. (Berlin)', coordinate: { x: lat, y: lng } }, arrival: null, departure: '2026-11-09T12:00:00Z', platform },
    name: 'Bus 248',
    category: 'B',
    number: '248',
    operator: null,
    to: 'S Südkreuz',
  })

  it('uses the platform names when every platform has one', () => {
    const info = assignPlatforms([entry(52.517, 13.41, '17'), entry(52.518, 13.412, '18')], transitousPosition)!
    expect(info.markers.map((m) => m.label)).toEqual(['17', '18'])
  })

  it('falls back to letters when platform names are missing', () => {
    const info = assignPlatforms([entry(52.517, 13.412, '17'), entry(52.518, 13.41, null)], transitousPosition)!
    expect(info.markers.map((m) => m.label)).toEqual(['A', 'B'])
    expect(info.markers[0].lng).toBe(13.41)
  })

  it('leaves big stations with many platforms to their platform numbers', () => {
    const many = [1, 2, 3, 4, 5].map((i) => entry(52.52 + i * 0.001, 13.41, String(i)))
    expect(assignPlatforms(many, transitousPosition)).toBeNull()
  })
})
