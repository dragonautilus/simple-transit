// Text formatting for the glasses display. Only glyphs present in the G2 firmware font are used
// (ASCII, Latin-1, → ↔, ● ○ ▶ ◆, box drawing).

import type { StationboardEntry } from './api'
import { lineName, parseTime, type Leg, type Point, type Progress, type Trip } from './journey'

/** Rough characters per line on the 576 px canvas (font is proportional). */
export const LINE_CHARS = 46

export function hhmm(t: number): string {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** "YYYY-MM-DD" in local time, as the timetable APIs expect. */
export function localDate(t: number): string {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function minutesUntil(t: number, now: number): number {
  return Math.round((t - now) / 60_000)
}

export function duration(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000))
  return min < 60 ? `${min}'` : `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}`
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(1, max - 1)).trimEnd()}…`
}

const utf8 = new TextEncoder()
const bytes = (s: string) => utf8.encode(s).length

/** Truncates to a UTF-8 byte budget: the glasses measure list items in bytes, and "→" alone takes 3. */
export function fitBytes(s: string, maxBytes: number): string {
  if (bytes(s) <= maxBytes) return s
  const chars = [...s]
  while (chars.length > 1 && bytes(`${chars.join('').trimEnd()}…`) > maxBytes) chars.pop()
  return `${chars.join('').trimEnd()}…`
}

const delay = (min: number) => (min > 0 ? ` +${min}'` : '')
const platform = (p: Point) => (p.platform ? ` Pl ${p.platform}${p.platformChanged ? '!' : ''}` : '')
const time = (p: Point) => `${hhmm(p.scheduled)}${delay(p.delayMin)}`

/** Station name without a trailing "(Town)", for headers where the town adds nothing. */
export const withoutTown = (name: string): string => name.replace(/\s\([^)]+\)$/, '')

/** Drop the locality prefix when the destination is in the same town ("Zürich, Central" → "Central"). */
export function shortStop(name: string, context?: string): string {
  // German style: "S+U Berlin Hauptbahnhof (Berlin)" → drop "(Berlin)" when the context is in Berlin too
  const suffix = /\s\(([^)]+)\)$/.exec(name)
  if (suffix) return context?.includes(`(${suffix[1]})`) ? name.slice(0, suffix.index) : name
  const i = name.indexOf(', ')
  if (i < 0) return name
  const town = name.slice(0, i)
  return context && context.startsWith(town) ? name.slice(i + 2) : name
}

// ---------- Departure board ----------

export interface BoardRow {
  when: string
  line: string
  dest: string
  info: string
}

/** One row per departure; rendered as aligned columns (time · line · → destination · platform/delay). */
export function boardRows(entries: StationboardEntry[], stationName: string, now: number, max: number, destChars = 25): BoardRow[] {
  const parse = (iso: string | null | undefined) => parseTime(iso) ?? NaN
  return entries
    .map((e) => {
      const sched = parse(e.stop.departure)
      const prog = parse(e.stop.prognosis?.departure)
      const delayMin = e.stop.delay ?? 0
      const eff = !Number.isNaN(prog) ? prog : sched + delayMin * 60_000
      return { e, eff, delayMin: Math.max(0, Math.round((eff - sched) / 60_000)) }
    })
    .filter((r) => !Number.isNaN(r.eff) && r.eff >= now - 30_000)
    .sort((a, b) => a.eff - b.eff)
    .slice(0, max)
    .map(({ e, eff, delayMin }) => {
      const mins = minutesUntil(eff, now)
      const plat = e.stop.prognosis?.platform ?? e.stop.platform
      return {
        when: mins <= 0 ? 'now' : mins < 60 ? `${mins}'` : hhmm(eff),
        line: truncate(lineName(e.category, e.number), 8),
        dest: `→ ${truncate(shortStop(e.to, stationName), destChars)}`,
        info: [plat, delayMin > 0 ? `+${delayMin}'` : ''].filter(Boolean).join(' '),
      }
    })
}

// ---------- Connection picker ----------

export function connectionItem(trip: Trip): string {
  const rides = trip.legs.filter((l) => l.kind === 'ride')
  const changes = Math.max(0, rides.length - 1)
  const lines = rides.map((l) => l.line).join(',')
  const first = trip.legs[0]
  const dep = first ? `${hhmm(first.from.scheduled)}${delay(first.from.delayMin)}` : '?'
  const s = `${dep}→${hhmm(trip.end)} ${duration(trip.end - trip.start)} ↔${changes} ${lines}`
  return truncate(s, 60)
}

// ---------- In-transit view ----------

export function tripHeader(targetName: string, trip: Trip, now: number): string {
  const last = trip.legs[trip.legs.length - 1]
  const left = trip.end - now
  const eta = left > 0 ? ` · ${duration(left)} left` : ''
  return truncate(`→ ${targetName}  arr ${last ? time(last.to) : '?'}${eta}`, LINE_CHARS + 4)
}

/** The single most important instruction right now. */
export function nextAction(trip: Trip, p: Progress, now: number): string {
  const leg = trip.legs[p.legIndex]
  const dest = trip.legs[trip.legs.length - 1]?.to
  if (!leg || !dest) return ''
  const context = trip.legs.find((l) => l.kind === 'ride')?.from.name
  const name = (n: string) => shortStop(n, context)
  if (p.arrived) return `Arrived at ${name(dest.name)}.`
  const inMin = (t: number) => {
    const m = minutesUntil(t, now)
    return m <= 0 ? 'now' : `in ${m}'`
  }

  if (leg.kind === 'walk') {
    const next = trip.legs[p.legIndex + 1]
    const s = `Walk to ${name(leg.to.name)} (${duration(leg.to.time - Math.max(now, leg.from.time))})`
    return next?.kind === 'ride' ? `${s}, ${next.line}${platform(next.from)} ${inMin(next.from.time)}` : s
  }
  if (p.waiting || p.time < leg.from.time) {
    return `Board ${leg.line} → ${name(leg.direction)}${platform(leg.from)} ${inMin(leg.from.time)}`
  }
  const next = trip.legs[p.legIndex + 1]
  const exit = `Exit at ${name(leg.to.name)} ${inMin(leg.to.time)}`
  return next?.kind === 'ride' ? `${exit}, then ${next.line}${platform(next.from)}` : exit
}

/**
 * Step list: every boarding, change (with arrival + departure platform and time) and the final
 * arrival. Returns lines and the index of the first line belonging to the current step.
 */
export function tripSteps(trip: Trip, p: Progress): { lines: string[]; currentLine: number } {
  const lines: string[] = []
  let currentLine = 0
  const mark = (legIdx: number) => (legIdx < p.legIndex ? '●' : legIdx === p.legIndex && !p.arrived ? '▶' : '○')

  const legs = trip.legs
  // Some networks put a short walk between two rides of a change (platform to platform)
  const isTransferWalk = (i: number) => legs[i]?.kind === 'walk' && legs[i - 1]?.kind === 'ride' && legs[i + 1]?.kind === 'ride'
  const context = legs.find((l) => l.kind === 'ride')?.from.name
  const stop = (name: string, max: number) => truncate(shortStop(name, context), max)

  legs.forEach((leg: Leg, i) => {
    if (i === p.legIndex) currentLine = lines.length
    if (isTransferWalk(i)) return // shown as part of the change below
    const walk = isTransferWalk(i - 1) ? legs[i - 1] : null
    const prev = walk ? legs[i - 2] : legs[i - 1]
    if (leg.kind === 'walk') {
      lines.push(`${mark(i)} Walk ${duration(leg.to.time - leg.from.time)} → ${stop(leg.to.name, 30)}`)
      return
    }
    if (prev?.kind === 'ride') {
      const wait = duration(leg.from.time - prev.to.time)
      const how = walk ? `${wait}, walk ${duration(walk.to.time - walk.from.time)}` : wait
      const at = walk && shortStop(prev.to.name, context) !== shortStop(leg.from.name, context) ? `${stop(prev.to.name, 18)} → ${stop(leg.from.name, 18)}` : stop(leg.from.name, 28)
      // A change counts as current while walking to the next platform
      lines.push(`${mark(walk && p.legIndex === i - 1 ? i - 1 : i)} Change at ${at} (${how})`)
      lines.push(`   arr ${time(prev.to)}${platform(prev.to)} → dep ${time(leg.from)}${platform(leg.from)}`)
    } else {
      lines.push(`${mark(i)} ${time(leg.from)}${platform(leg.from)}  ${stop(leg.from.name, 26)}`)
    }
    lines.push(`   ${leg.line} → ${truncate(shortStop(leg.direction, context), LINE_CHARS - leg.line.length - 6)}`)
  })

  const last = legs[legs.length - 1]
  if (last) {
    if (p.arrived) currentLine = lines.length
    lines.push(`${p.arrived ? '▶' : '○'} ${time(last.to)}${platform(last.to)}  ${stop(last.to.name, 28)}`)
  }
  return { lines, currentLine }
}
