// Glasses side: departure board of the closest stops, target/connection picker and the journey
// view. Every bridge call is a Bluetooth round trip (see bridge.ts), so the code below avoids
// sending anything that is already on screen and sends images only when they changed.

import {
  AppLocationAccuracy,
  type AppLocation,
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
  ImuReportPace,
  ListContainerProperty,
  ListItemContainerProperty,
  OsEventTypeList,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk'
import type * as api from './api'
import { DEFAULT_SETTINGS, bridgeStats, cachedSettings, loadSettings, loadTargets, serial, type Settings, type Target } from './bridge'
import { DEFAULT_NETWORK, NETWORKS, candidates, getNetwork, isDown, markDown, networkFor, opendata, type Network } from './networks'
import { MAP_H, MAP_W, compass, renderMapPng } from './map/board-map'
import { assignPlatforms, cachedTable, loadSwissTable, swissPosition, transitousPosition, type PlatformInfo } from './map/platforms'
import { cachedCheckIn, checkInExpired, loadCheckIn, saveCheckIn, type CheckIn } from './checkin'
import {
  boardRows,
  shownDepartures,
  connectionItem,
  hhmm,
  localDate,
  nextAction,
  withoutTown,
  tripHeader,
  tripSteps,
  truncate,
  fitBytes,
  type BoardRow,
} from './format'
import { buildTrip, distanceM, estimateProgress, type Fix, type Trip } from './journey'
import { fastForward, logImu, mark, mockFix, mockTargets, slowImageMs, startDevHooks, now as clock } from './dev'
import { angleDiff, currentHeading, learnFromFix, startCompass } from './heading'
import { HALF_W, LINE_H, dotX, renderProgressPngs } from './progress-image'

type Mode = 'loading' | 'board' | 'targets' | 'connections' | 'transit' | 'confirmStop' | 'message'

const BOARD_ROWS = 7
const STEP_ROWS = 5
const BOARD_REFRESH_MS = 30_000
const TRIP_REFRESH_MS = 60_000
const TICK_MS = 10_000
/** Journey line updates while riding: at most this often (forced updates always go out). */
const IMAGE_MIN_INTERVAL_MS = 8_000
const NEARBY_REQUERY_M = 150
const BACK = '‹ Back'
/** The glasses reject a whole list page if one item is longer than 64 bytes (docs: "64 characters"). */
const LIST_ITEM_BYTES = 60
const LIST_MAX_ITEMS = 20
const CONFIRM_ITEMS = ['Continue journey', 'Close app · stay checked in', 'Check out'] as const
const BOARD_FOOTER = '▲▼ other stops · tap: navigate · 2×: exit'
/** Clock in the top right corner of every page; headers end left of it. */
const CLOCK_X = 500
const CLOCK_W = 576 - CLOCK_X
type BoardColumn = { name: keyof BoardRow; x: number; w: number; capture: boolean }
const BOARD_COLUMNS: readonly BoardColumn[] = [
  { name: 'time', x: 0, w: 62, capture: false },
  { name: 'when', x: 62, w: 48, capture: false },
  { name: 'line', x: 110, w: 92, capture: false },
  { name: 'dest', x: 202, w: 286, capture: true },
  { name: 'info', x: 488, w: 88, capture: false },
]
/** Narrower, leaving room for the map on the right. Without the departure time: there is no
 *  room for it, and the page would need 9 text containers (the glasses allow 8). */
const MAP_X = 576 - MAP_W
const BOARD_COLUMNS_MAP: readonly BoardColumn[] = [
  { name: 'when', x: 0, w: 52, capture: false },
  { name: 'line', x: 52, w: 88, capture: false },
  { name: 'dest', x: 140, w: 190, capture: true },
  { name: 'info', x: 330, w: 102, capture: false },
]
const boardColumns = (withMap: boolean) => (withMap ? BOARD_COLUMNS_MAP : BOARD_COLUMNS)
/** Container ids after the columns (header is 1, columns start at 2). */
const MAPINFO_ID = BOARD_COLUMNS_MAP.length + 3
const MAP_ID = MAPINFO_ID + 1
const DEST_CHARS = 23
const DEST_CHARS_MAP = 15
/** Redraw the map when you moved this far (m)… */
const MAP_REDRAW_M = 40
/** …but at most this often: every image costs a slow Bluetooth transfer that delays all other
 *  updates. Your position is the least urgent part of the map: the stop doesn't move. */
const MAP_MIN_INTERVAL_MS = 30_000
/** Turn the map when you turned this far (°)… */
const MAP_TURN_DEG = 20
/** …at most this often, so you can get your bearings while turning around. Each redraw also
 *  brings your position up to date. */
const MAP_TURN_INTERVAL_MS = 2500
/** While swiping through stops, the map waits until you pause, so the Bluetooth link isn't busy
 *  with maps of stops you skip past. */
const MAP_SWIPE_SETTLE_MS = 700
/** How long the first map of a Swiss stop waits for its platforms (ms). */
const PLATFORM_WAIT_MS = 2500
/** Fixes less accurate than this (m) don't move the map dot (GPS warming up). */
const MAP_MAX_ACCURACY_M = 60
/** Last departure board, shown instantly on the next start while fresh data loads. */
const SNAPSHOT_KEY = 'sst.boardSnapshot'
const SNAPSHOT_MAX_AGE_MS = 20 * 60_000
/** Departures of the other nearby stops are prefetched so swiping is instant. */
const BOARD_CACHE_MS = 60_000
/** A position older than this is refreshed before planning a trip. */
const STALE_FIX_MS = 5 * 60_000
/** Walking speed for the "n' walk" hint, m/min. */
const WALK_M_PER_MIN = 75
/** In automatic mode, try the next network when the closest stop is further than this (m). */
const FALLBACK_M = 1500

const toFix = (l: AppLocation): Fix => ({
  lat: l.latitude,
  lng: l.longitude,
  accuracy: l.accuracy,
  timestamp: l.timestamp ?? clock(),
  heading: l.heading,
  speed: l.speed,
})

interface ConnectionOption {
  trip: Trip
  query: api.ConnectionQuery
  /** Network the query (stop ids) belongs to: the target's own, or another one after a failure. */
  network: Network
}

const COORDS = /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/

interface BoardContent {
  header: string
  /** Newline-joined cells per column, same order as boardColumns(). */
  columns: string[]
  /** Text under the map: distance, direction and walking time to the stop. */
  mapInfo: string
}

export interface GlassesStatus {
  mode: Mode
  summary: string
  /** Journey you are checked into, if any. */
  checkIn: { label: string; arrival: number } | null
}

export class GlassesApp {
  private mode: Mode = 'loading'
  private started = false
  private foreground = true

  private fix: Fix | null = null
  private nearbyFix: Fix | null = null
  private stations: api.Location[] = []
  private stationIdx = 0
  private board: api.StationboardEntry[] = []
  private settings: Settings = DEFAULT_SETTINGS
  /** Network of the departure board (targets carry their own). */
  private network: Network = getNetwork(DEFAULT_NETWORK)
  /** The board uses another network because the chosen one failed; switch back once it may work again. */
  private failover = false
  /** Board layout currently on screen: with or without map. */
  private boardWithMap = false
  private mapKey = ''
  private mapFix: Fix | null = null
  /** Heading the map on screen is turned to; null: north up. */
  private mapHeading: number | null = null
  private mapBusy = false
  private mapPending = false
  private mapSentAt = 0
  private swipedAt = 0
  private mapTimer: ReturnType<typeof setTimeout> | undefined
  /** Counts page changes. Updates are queued, and one queued for a page that has been replaced
   *  meanwhile must be dropped: sent to a container that no longer exists, an image can stall
   *  the glasses (blank pages, no reaction to input). */
  private page = 0
  /** Text currently on the glasses per container; unchanged text is not sent again. */
  private shown = new Map<string, string>()
  /** Departures per stop id, for instant swiping between stops. */
  private boardCache = new Map<string, { entries: api.StationboardEntry[]; at: number }>()
  private boardFetchedAt = 0
  private boardError = ''

  private targets: Target[] = []
  private pendingTarget: Target | null = null
  private options: ConnectionOption[] = []
  /** Checked-in journey: shown in transit mode and restored on the next app start. */
  private active: CheckIn | null = null
  private stepOffset = 0
  private stepScrolledUntil = 0
  private lastDotX = -1
  private imageBusy = false
  private imagePending = false
  private imageFailures = 0
  private imageSentAt = 0
  private lastRing = false

  /** Id of the clock container on the current page (always the last one). */
  private clockId = 0
  private clockTimer: ReturnType<typeof setTimeout> | undefined
  private timer: ReturnType<typeof setInterval> | null = null
  private unsubscribers: (() => void)[] = []

  constructor(
    private bridge: EvenAppBridge,
    private onStatus: (s: GlassesStatus) => void = () => {},
  ) {}

  async start(): Promise<void> {
    // The "app starting" notice stays until the first page exists, so that page is built from
    // synchronous local copies only; the Even app storage is read right after.
    this.settings = cachedSettings()
    const saved = cachedCheckIn()
    // Checked in: open straight into the journey from the stored timetable, no GPS/network wait
    const resume = saved && !checkInExpired(saved, clock(), null) ? saved : null
    if (saved && !resume) void saveCheckIn(null)
    // Otherwise open straight into the last departure board (if recent) while fresh data loads
    const snapshot = resume ? false : this.restoreSnapshot()
    let first: Partial<CreateStartUpPageContainer>
    if (resume) first = this.withClock(this.transitLayout())
    else if (snapshot) {
      const texts = this.boardTexts(this.boardContent(clock()), this.settings.map)
      first = this.withClock({ textObject: texts, ...(this.settings.map ? { imageObject: [this.mapImage()] } : {}) })
      this.mode = 'board'
      this.boardWithMap = this.settings.map
    } else first = this.withClock({ textObject: this.messageTexts('Simple transit', 'Locating closest stops…', ' ') })
    await serial(() => this.bridge.createStartUpPageContainer(new CreateStartUpPageContainer(first)))
    this.page++
    this.remember(first.textObject)
    mark(`first page (${resume ? 'journey' : snapshot ? 'last board' : 'loading'}), bridge calls before it: ${bridgeStats.calls - 1}`)
    this.started = true
    if (snapshot) {
      if (this.boardWithMap) void this.sendMap(true)
      void this.loadBoard().then(() => this.prefetchBoards())
    }
    if (!resume) void this.loadStored(false)
    this.unsubscribers.push(this.bridge.onEvenHubEvent((e) => void this.onEvent(e).catch((err) => this.failed(err))))
    if (resume) {
      this.active = resume
      this.enterTransitMode()
      await this.renderTransit(true)
      // Only now, so the reads don't queue in front of the first journey frame
      void this.loadStored(true)
      // Delays may have changed while the app was closed
      void this.refreshTrip().then(() => this.renderTransit(true))
    }
    this.unsubscribers.push(
      this.bridge.onAppLocationChanged((l) => {
        if (mockFix) return
        this.fix = toFix(l)
        learnFromFix(this.fix, clock())
        void this.onFix().catch(() => undefined)
      }),
    )
    void this.startLocation()
    this.unsubscribers.push(startCompass(() => void this.onHeading()))
    if (logImu) void this.bridge.imuControl(true, ImuReportPace.P500).catch(() => false)
    const firstFix = mockFix ? { ...mockFix, timestamp: clock() } : await this.quickFix()
    if (firstFix) {
      this.fix = firstFix
      await this.onFix()
    } else if (!this.fix && !resume && !snapshot) {
      await this.showMessage('No GPS fix yet', 'Waiting for location…\nCheck that the Even app may use your location.', 'loading')
    }
    this.timer = setInterval(() => void this.tick().catch(() => undefined), TICK_MS)
    this.scheduleClock()
    startDevHooks(
      (fix) => {
        this.fix = fix
        void this.onFix()
      },
      () => `bridge calls ${bridgeStats.calls}, busy ${Math.round(bridgeStats.busyMs)} ms`,
    )
  }

  /** The Even app storage is authoritative; the first frame was built from the local mirror. */
  private async loadStored(resumed: boolean) {
    const [targets, settings, saved] = await Promise.all([loadTargets(), loadSettings(), loadCheckIn()])
    this.targets = targets.length ? targets : mockTargets
    if (this.mode === 'targets') await this.showTargets()
    if (JSON.stringify(settings) !== JSON.stringify(this.settings)) await this.setSettings(settings)
    if (!resumed && !this.active && saved && !checkInExpired(saved, clock(), this.fix) && this.showsBoard()) {
      // Checked in, but the WebView mirror was reset
      this.active = saved
      await this.showTransit().catch((err) => this.failed(err))
      void this.refreshTrip().then(() => this.renderTransit(true))
    }
  }

  /** Coarse first: it is fast and good enough to find nearby stops. Precise positions follow
   *  through the location updates. */
  private async quickFix(): Promise<Fix | null> {
    const get = (accuracy: AppLocationAccuracy, timeoutMs: number) =>
      this.bridge.getAppLocation({ accuracy, timeoutMs }).then((l) => (l ? toFix(l) : null)).catch(() => null)
    return (await get(AppLocationAccuracy.Medium, 2500)) ?? (this.fix ? null : await get(AppLocationAccuracy.High, 8000))
  }

  private saveSnapshot() {
    try {
      localStorage.setItem(
        SNAPSHOT_KEY,
        JSON.stringify({
          at: clock(),
          network: this.network.id,
          fix: this.nearbyFix,
          stations: this.stations,
          stationIdx: this.stationIdx,
          board: this.board,
        }),
      )
    } catch {
      // storage full or unavailable: the next start just waits for fresh data
    }
  }

  /** Loads the last board into state; true if it is recent enough to show. */
  private restoreSnapshot(): boolean {
    try {
      const s = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) ?? 'null')
      const usable = Array.isArray(s?.stations) && s.stations.length > 0 && Array.isArray(s.board) && typeof s.at === 'number' && s.fix
      if (!usable || clock() - s.at > SNAPSHOT_MAX_AGE_MS) return false
      this.network = getNetwork(s.network)
      this.stations = s.stations
      this.stationIdx = Math.min(s.stationIdx ?? 0, s.stations.length - 1)
      this.board = s.board
      this.boardFetchedAt = s.at
      this.nearbyFix = s.fix
      this.fix = s.fix
      // Saved while another network stood in: return to the chosen one once it answers
      this.failover = this.network !== networkFor(this.settings.network, s.fix.lat, s.fix.lng)
      return true
    } catch {
      return false
    }
  }

  /** Location updates stop when the WebView is suspended, so this also runs on every resume. */
  private async startLocation() {
    if (mockFix) return
    await this.bridge
      .startAppLocationUpdates({ accuracy: AppLocationAccuracy.High, intervalMs: 5000, distanceFilter: 10 })
      .catch(() => false)
  }

  /** An error after a tap: shown with its text instead of leaving a blank or half-built page. */
  private async failed(err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    mark(`error: ${msg}`)
    if (this.mode === 'message') return // the message page itself failed: nothing better to show
    await this.showMessage('Something went wrong', `${truncate(msg, 140)}\nTap to go back.`).catch(() => undefined)
  }

  /** From the phone app. */
  async checkOut(): Promise<void> {
    if (this.active) await this.endTransit()
  }

  async setSettings(settings: Settings): Promise<void> {
    const networkChanged = settings.network !== this.settings.network
    this.settings = settings
    if (networkChanged) {
      this.nearbyFix = null
      if (this.showsBoard()) await this.loadNearby()
    } else if (this.mode === 'board' && this.boardWithMap !== settings.map) {
      this.mode = 'loading' // forces a rebuild with the other layout
      await this.renderBoard()
    } else if (this.mode === 'board' && this.boardWithMap) {
      await this.sendMap() // turned or back to north up
    }
  }

  async setTargets(targets: Target[]): Promise<void> {
    this.targets = targets
    if (this.mode === 'targets') await this.showTargets()
  }

  private stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    clearTimeout(this.clockTimer)
    this.clockTimer = undefined
    this.unsubscribers.forEach((u) => u())
    this.unsubscribers = []
    void this.bridge.stopAppLocationUpdates().catch(() => false)
  }

  private status(summary: string) {
    const a = this.active
    this.onStatus({ mode: this.mode, summary, checkIn: a ? { label: a.target.label, arrival: a.trip.end } : null })
  }

  // ---------- Layout helpers ----------

  private text(id: number, name: string, y: number, h: number, content: string, capture = false, extra = {}) {
    return new TextContainerProperty({
      xPosition: 0,
      yPosition: y,
      width: 576,
      height: h,
      containerID: id,
      containerName: name,
      content: content || ' ',
      isEventCapture: capture ? 1 : 0,
      borderWidth: 0,
      paddingLength: 4,
      ...extra,
    })
  }

  /** Adds the clock as the last container and sets the container count. */
  private withClock<P extends { textObject?: TextContainerProperty[]; listObject?: unknown[]; imageObject?: unknown[] }>(page: P) {
    const others = (page.textObject?.length ?? 0) + (page.listObject?.length ?? 0) + (page.imageObject?.length ?? 0)
    this.clockId = others + 1
    const t = this.text(this.clockId, 'clock', 0, 36, hhmm(clock()), false, { xPosition: CLOCK_X, width: CLOCK_W })
    return { ...page, textObject: [...(page.textObject ?? []), t], containerTotalNum: others + 1 }
  }

  /** Redraws right after every minute change, so the clock and the "departs in" minutes agree. */
  private scheduleClock() {
    clearTimeout(this.clockTimer)
    this.clockTimer = setTimeout(() => {
      void this.tick().catch(() => undefined)
      this.scheduleClock()
    }, 60_000 - (clock() % 60_000) + 200)
  }

  private async updateClock() {
    if (this.clockId) await this.upgrade(this.clockId, 'clock', hhmm(clock()))
  }

  private messageTexts(header: string, body: string, footer: string) {
    return [
      this.text(1, 'hdr', 0, 36, truncate(header, 38), false, { width: CLOCK_X }),
      this.text(2, 'body', 36, 216, body, true),
      this.text(3, 'foot', 252, 36, footer, false, { textColor: 2 }),
    ]
  }

  /** Departure table: one text container per column so the columns line up despite the
   *  proportional firmware font. All columns share y and height, so rows align. */
  private boardTexts(c: BoardContent, withMap: boolean) {
    const col = (id: number, name: string, x: number, w: number, content: string, capture = false) =>
      this.text(id, name, 36, 216, content, capture, { xPosition: x, width: w })
    const columns = boardColumns(withMap)
    const texts = [
      this.text(1, 'hdr', 0, 36, c.header, false, { width: CLOCK_X }),
      ...columns.map((k, i) => col(i + 2, k.name, k.x, k.w, c.columns[i], k.capture)),
      this.text(columns.length + 2, 'foot', 252, 36, BOARD_FOOTER, false, { textColor: 2 }),
    ]
    if (withMap) {
      texts.push(this.text(MAPINFO_ID, 'mapinfo', 36 + MAP_H + 2, 216 - MAP_H - 2, c.mapInfo, false, { xPosition: MAP_X, width: MAP_W }))
    }
    return texts
  }

  private mapImage() {
    return new ImageContainerProperty({ xPosition: MAP_X, yPosition: 38, width: MAP_W, height: MAP_H, containerID: MAP_ID, containerName: 'map' })
  }

  /** Records what a new page shows, so upgrade() can skip unchanged text. */
  private remember(texts: TextContainerProperty[] | undefined) {
    this.shown.clear()
    for (const t of texts ?? []) this.shown.set(t.containerName ?? '', t.content ?? ' ')
  }

  /** False if the glasses refused the page; the previous page then stays on screen. */
  private async rebuild(page: Partial<RebuildPageContainer>): Promise<boolean> {
    if (!this.started) return false
    const full = this.withClock(page)
    this.remember(full.textObject)
    this.page++
    const ok = await serial(() => this.bridge.rebuildPageContainer(new RebuildPageContainer(full)))
    if (!ok) mark('page refused by the glasses')
    return ok
  }

  /** Sends an image to a container of the current page; false if the page changed before it was its turn. */
  private async sendImage(id: number, name: string, png: number[]): Promise<boolean> {
    const page = this.page
    const result = await serial(
      async () => {
        if (page !== this.page) return null
        if (slowImageMs) await new Promise((r) => setTimeout(r, slowImageMs))
        return this.bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: id, containerName: name, imageData: png }))
      },
      10_000,
      'low',
    )
    if (result === null) return false
    if (result !== ImageRawDataUpdateResult.success) throw new Error(`image ${name}: ${result}`)
    return true
  }

  private async upgrade(id: number, name: string, content: string) {
    if (!this.started || !this.foreground) return
    content ||= ' '
    if (this.shown.get(name) === content) return
    this.shown.set(name, content)
    const page = this.page
    await serial(async () =>
      page === this.page
        ? this.bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: id, containerName: name, content, contentOffset: 0, contentLength: 0 }))
        : false,
    ).catch(() => this.shown.delete(name))
  }

  /** Full-screen text page. 'loading' switches to the board by itself once departures arrive. */
  private async showMessage(header: string, body: string, mode: 'message' | 'loading' = 'message') {
    const sameLayout = this.mode === 'message' || this.mode === 'loading'
    this.mode = mode
    const footer = mode === 'message' ? 'tap: back' : ' '
    if (!sameLayout) await this.rebuild({ textObject: this.messageTexts(header, body, footer) })
    else {
      await this.upgrade(1, 'hdr', truncate(header, 38))
      await this.upgrade(2, 'body', body)
      await this.upgrade(3, 'foot', footer)
    }
  }

  private async showList(header: string, items: string[]): Promise<boolean> {
    const names = items.slice(0, LIST_MAX_ITEMS).map((s) => fitBytes(s, LIST_ITEM_BYTES))
    return this.rebuild({
      textObject: [this.text(1, 'hdr', 0, 40, header, false, { width: CLOCK_X })],
      listObject: [
        new ListContainerProperty({
          xPosition: 0,
          yPosition: 44,
          width: 576,
          height: Math.min(244, Math.max(2, names.length) * 40),
          containerID: 2,
          containerName: 'list',
          isEventCapture: 1,
          borderWidth: 0,
          paddingLength: 4,
          itemContainer: new ListItemContainerProperty({ itemCount: names.length, itemWidth: 0, isItemSelectBorderEn: 1, itemName: names }),
        }),
      ],
    })
  }

  // ---------- Departure board ----------

  /** The compass turned (throttled in heading.ts): turn the map if it's on screen. */
  private async onHeading() {
    if (this.foreground && this.mode === 'board' && this.boardWithMap) await this.sendMap()
  }

  /** Direction the map should face, null for north up. */
  private mapHeadingNow(): number | null {
    return this.settings.rotate ? (currentHeading(this.fix, clock())?.deg ?? null) : null
  }

  private async onFix() {
    if (!this.fix) return
    if (this.mode === 'transit') return this.renderTransit()
    const moved = !this.nearbyFix || distanceM(this.nearbyFix, this.fix) > NEARBY_REQUERY_M
    if (moved) await this.loadNearby()
    else if (this.mode === 'board') await this.renderBoard()
  }

  private async loadNearby() {
    if (!this.fix) return
    const fix = this.fix
    const now = clock()
    const prevId = this.stations[this.stationIdx]?.id
    // The chosen network first; the next one when it fails or (automatic mode) finds no stop close by
    let best: { network: Network; stations: api.Location[] } | null = null
    for (const network of candidates(this.settings.network, fix.lat, fix.lng, now)) {
      const closeEnough = best && best.stations.length > 0 && (best.stations[0].distance ?? 0) <= FALLBACK_M
      if (best && (closeEnough || this.settings.network !== 'auto')) break
      try {
        const stations = await network.nearbyStations(fix.lat, fix.lng)
        const closer = !best || (stations.length > 0 && (best.stations.length === 0 || (stations[0].distance ?? Infinity) < (best.stations[0].distance ?? Infinity)))
        if (closer) best = { network, stations }
      } catch {
        markDown(network, clock())
      }
    }
    if (!best) {
      this.boardError = 'Offline · retrying'
      if (this.showsBoard()) await this.renderBoard()
      return
    }
    this.network = best.network
    this.failover = isDown(networkFor(this.settings.network, fix.lat, fix.lng), clock())
    this.stations = best.stations
    this.nearbyFix = fix
    const keep = this.stations.findIndex((s) => s.id === prevId)
    this.stationIdx = keep >= 0 ? keep : 0
    this.boardCache.clear()
    await this.loadBoard()
    void this.prefetchBoards()
  }

  /** Board is on screen, or the startup/loading page that the board replaces. */
  private showsBoard() {
    return this.mode === 'board' || this.mode === 'loading'
  }

  private async loadBoard() {
    const station = this.stations[this.stationIdx]
    if (!station?.id) {
      this.board = []
      return this.showsBoard() ? this.renderBoard() : undefined
    }
    try {
      const entries = await this.network.stationboard(station.id, 15)
      if (this.stations[this.stationIdx] !== station) return // swiped away meanwhile
      this.board = entries
      this.boardFetchedAt = clock()
      this.boardCache.set(station.id, { entries, at: this.boardFetchedAt })
      this.boardError = ''
      this.saveSnapshot()
    } catch {
      // Another network may still work: switch the board to its stops
      markDown(this.network, clock())
      const other = this.fix && candidates(this.settings.network, this.fix.lat, this.fix.lng, clock()).some((n) => !isDown(n, clock()))
      if (other) return this.loadNearby()
      this.boardError = 'Offline · retrying'
    }
    if (this.showsBoard()) await this.renderBoard()
  }

  /** Departures of the other nearby stops, one after the other, so swiping shows them at once. */
  private async prefetchBoards() {
    const network = this.network
    for (const s of this.stations) {
      if (!s.id || network !== this.network || this.boardCache.has(s.id)) continue
      try {
        this.boardCache.set(s.id, { entries: await network.stationboard(s.id, 15), at: clock() })
      } catch {
        return
      }
    }
  }

  /** Live distance (m) from the current fix to a stop, falling back to the API's value. */
  private distanceTo(station: api.Location): number | null {
    const c = station.coordinate
    if (this.fix && c?.x != null && c.y != null) return distanceM(this.fix, { lat: c.x, lng: c.y })
    return station.distance ?? null
  }

  private boardContent(now: number, placeholder?: string): BoardContent {
    const station = this.stations[this.stationIdx]
    if (!station) {
      return { header: 'No stops nearby', columns: ['', '', 'No public transport stop found around you.', ''], mapInfo: ' ' }
    }
    const exact = this.distanceTo(station)
    // Rounded, so GPS jitter doesn't change the text (and cost an update) every few seconds
    const metres = exact == null ? null : exact < 200 ? Math.round(exact / 10) * 10 : Math.round(exact / 50) * 50
    const dist = metres != null ? ` · ${metres} m` : ''
    const page = this.stations.length > 1 ? `  ${this.stationIdx + 1}/${this.stations.length}` : ''
    const header = `${truncate(withoutTown(station.name ?? '?'), 26)}${dist}${page}`
    const c = station.coordinate
    const where = metres != null && this.fix && c?.x != null && c.y != null ? `${metres} m ${compass(this.fix, { lat: c.x, lng: c.y })}` : ' '
    const walk = metres != null ? `${Math.max(1, Math.round(metres / WALK_M_PER_MIN))}' walk` : ' '
    // The map image takes seconds over Bluetooth, text is instant
    const mapInfo = `${where}\n${this.mapKey === this.mapKeyNow() ? walk : 'Map updating…'}`
    const destChars = this.settings.map ? DEST_CHARS_MAP : DEST_CHARS
    const rows = placeholder ? [] : boardRows(this.board, station.name ?? '', now, this.departureRows(), destChars, this.platformInfo(now)?.labelOf)
    const note = placeholder ?? (rows.length === 0 ? 'No upcoming departures.' : '')
    const extra = [note, this.boardError].filter(Boolean)
    const column = (k: keyof BoardRow) =>
      [...rows.map((r) => r[k]), ...extra.map((e) => (k === 'dest' ? e : ' '))].slice(0, BOARD_ROWS).join('\n')
    return { header, columns: boardColumns(this.settings.map).map((k) => column(k.name)), mapInfo }
  }

  private async renderBoard(placeholder?: string) {
    const c = this.boardContent(clock(), placeholder)
    const withMap = this.settings.map
    const rebuilt = this.mode !== 'board' || this.boardWithMap !== withMap
    if (rebuilt) {
      this.mode = 'board'
      this.boardWithMap = withMap
      this.mapKey = ''
      await this.rebuild({ textObject: this.boardTexts(c, withMap), ...(withMap ? { imageObject: [this.mapImage()] } : {}) })
    } else {
      await this.upgrade(1, 'hdr', c.header)
      for (const [i, { name }] of boardColumns(withMap).entries()) await this.upgrade(i + 2, name, c.columns[i])
      if (withMap) await this.upgrade(MAPINFO_ID, 'mapinfo', c.mapInfo)
    }
    if (withMap) void this.sendMap(rebuilt)
    const net = this.network.id === DEFAULT_NETWORK ? '' : ` (${this.network.name})`
    this.status(`Departures · ${this.stations[this.stationIdx]?.name ?? 'locating'}${net}`)
  }

  /** Sends the map image when the stop list or the selected stop changed (at once), or when you
   *  moved noticeably (throttled). force: the image container is new and still empty. */
  private async sendMap(force = false) {
    if (!this.foreground || this.mode !== 'board' || !this.boardWithMap) return
    if (this.mapBusy) {
      this.mapPending = true
      return
    }
    const station = this.stations[this.stationIdx]
    const key = this.mapKeyNow()
    const goodFix = !!this.fix && (this.fix.accuracy ?? 0) <= MAP_MAX_ACCURACY_M
    const moved = goodFix && (!this.mapFix || distanceM(this.mapFix, this.fix!) >= MAP_REDRAW_M)
    const due = clock() - this.mapSentAt >= MAP_MIN_INTERVAL_MS
    const heading = this.mapHeadingNow()
    const turned =
      (heading == null) !== (this.mapHeading == null) ||
      (heading != null && this.mapHeading != null && angleDiff(heading, this.mapHeading) >= MAP_TURN_DEG)
    const turnDue = clock() - this.mapSentAt >= MAP_TURN_INTERVAL_MS
    if (!station || (!force && key === this.mapKey && !(moved && due) && !(turned && turnDue))) return
    const settle = this.swipedAt + MAP_SWIPE_SETTLE_MS - clock()
    if (settle > 0) {
      clearTimeout(this.mapTimer)
      this.mapTimer = setTimeout(() => void this.sendMap(force), settle)
      return
    }
    // Swiss stops: platforms come from a Transitous lookup (cached). Wait briefly for it, so the
    // first map already shows them instead of costing a second image transfer.
    if (this.network === opendata && station.id && !cachedTable(station.id, clock())) {
      const load = loadSwissTable(station, this.stations, clock())
      void load.then((table) => {
        if (table && this.stations[this.stationIdx] === station && this.mode === 'board') void this.renderBoard()
      })
      await Promise.race([load, new Promise((r) => setTimeout(r, PLATFORM_WAIT_MS))])
      // Found: the renderBoard() above sends the map. Swiped meanwhile: the next stop's map follows.
      if (cachedTable(station.id, clock()) || this.stations[this.stationIdx] !== station) return
    }
    this.mapBusy = true
    this.mapPending = false
    const fix = this.fix
    // Latest direction: it may have changed while waiting for the platforms
    const facing = this.mapHeadingNow()
    let sent = false
    try {
      const png = await renderMapPng({
        me: fix ? { lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy } : null,
        stations: this.stations
          .map((s) => s.coordinate)
          .map((c) => (c?.x != null && c.y != null ? { lat: c.x, lng: c.y } : { lat: NaN, lng: NaN })),
        selected: this.stationIdx,
        platforms: this.platformInfo(clock())?.markers,
        label: this.stations.length > 1 ? `${this.stationIdx + 1}/${this.stations.length}` : '',
        heading: facing,
      })
      if (this.mode !== 'board' || !this.boardWithMap) return
      // Page changed while waiting: the next board page sends its own map
      sent = await this.sendImage(MAP_ID, 'map', png)
      if (!sent) return
      this.mapKey = key
      this.mapFix = fix
      this.mapHeading = facing
      this.mapSentAt = clock()
    } catch {
      this.mapKey = '' // retried on the next tick
    } finally {
      this.mapBusy = false
    }
    // Updates "Map updating…" and sends the next map if the stop changed meanwhile
    if (sent && this.mode === 'board') void this.renderBoard()
    else if (this.mapPending) void this.sendMap()
  }

  /** Rows for departures: a full board leaves the last one to an error ("Offline · retrying"),
   *  so old departures don't pass as live. */
  private departureRows() {
    return BOARD_ROWS - (this.boardError ? 1 : 0)
  }

  /** Platforms the shown departures leave from, when they are in different places. Uses
   *  cached data only; sendMap() loads what is missing. */
  private platformInfo(now: number): PlatformInfo | null {
    const station = this.stations[this.stationIdx]
    if (!this.settings.map || !station?.id) return null
    const shown = shownDepartures(this.board, now, this.departureRows())
    if (this.network !== opendata) return assignPlatforms(shown, transitousPosition)
    const table = cachedTable(station.id, now)
    return table ? assignPlatforms(shown, (e) => swissPosition(table, e)) : null
  }

  /** Changes with everything the map image shows apart from your position. */
  private mapKeyNow() {
    const id = this.stations[this.stationIdx]?.id
    const platforms = this.platformInfo(clock())?.markers.map((m) => `${m.label}@${m.lat},${m.lng}`).join(';') ?? ''
    return `${this.stations.map((s) => s.id).join(',')}#${this.stationIdx}#${id}#${platforms}`
  }

  private async switchStation(delta: number) {
    if (this.stations.length < 2) return
    this.stationIdx = (this.stationIdx + delta + this.stations.length) % this.stations.length
    this.swipedAt = clock()
    const id = this.stations[this.stationIdx].id
    const cached = id ? this.boardCache.get(id) : undefined
    if (cached && clock() - cached.at < BOARD_CACHE_MS) {
      this.board = cached.entries
      this.boardFetchedAt = cached.at
      return this.renderBoard()
    }
    this.board = []
    await this.renderBoard('Loading departures…')
    await this.loadBoard()
  }

  // ---------- Target + connection picker ----------

  private async showTargets() {
    this.mode = 'targets'
    if (this.targets.length === 0) {
      await this.showList('No targets · add them in the phone app', [BACK])
    } else {
      await this.showList('Navigate to…', [...this.targets.map((t) => `→ ${t.label}`), BACK])
    }
    this.status('Choosing a target')
  }

  private async pickTarget(target: Target) {
    // The position may still be the one from the last board snapshot
    const stale = () => !this.fix || clock() - (this.fix.timestamp ?? 0) > STALE_FIX_MS
    if (!mockFix && stale()) {
      await this.showMessage(`→ ${target.label}`, 'Getting your position…')
      this.fix = (await this.quickFix()) ?? (stale() ? null : this.fix)
    }
    if (!this.fix) {
      await this.showMessage('No GPS fix', 'Your position is needed to plan the trip.\nTap to go back.')
      return
    }
    this.pendingTarget = target
    await this.showMessage(`→ ${target.label}`, 'Searching connections…')
    const now = clock()
    const query: api.ConnectionQuery = {
      from: `${this.fix.lat.toFixed(6)},${this.fix.lng.toFixed(6)}`,
      to: target.query,
      date: localDate(now),
      time: hhmm(now),
      toName: target.label,
    }
    this.options = await this.findConnections(target, query, this.fix)
    if (this.options.length === 0) {
      await this.showMessage(`→ ${target.label}`, 'No connection found (or offline).\nTap to go back.')
      return
    }
    const shown = await this.showList(`→ ${truncate(target.label, 20)} · pick a connection`, [
      ...this.options.map((o) => connectionItem(o.trip)),
      BACK,
    ])
    if (!shown) {
      await this.showMessage(`→ ${target.label}`, 'The glasses could not show the connections.\nTap to go back.')
      return
    }
    this.mode = 'connections'
    this.status(`Choosing a connection to ${target.label}`)
  }

  /** Connections from the target's own network; when it fails, from another network covering
   *  your position (the destination stop is looked up there by name, stop ids differ). */
  private async findConnections(target: Target, query: api.ConnectionQuery, fix: Fix): Promise<ConnectionOption[]> {
    const own = getNetwork(target.network)
    const now = clock()
    const others = NETWORKS.filter((n) => n !== own && n.covers(fix.lat, fix.lng))
    const order = [own, ...others].sort((a, b) => Number(isDown(a, now)) - Number(isDown(b, now)))
    for (const network of order) {
      try {
        let q = query
        if (network !== own && !COORDS.test(target.query)) {
          const stop = (await network.searchLocations(target.place)).find((l) => l.id)
          if (!stop?.id) continue
          q = { ...query, to: stop.id }
        }
        const conns = await network.connections(q, 5)
        return conns.map((c) => ({ trip: buildTrip(c), query: q, network })).filter((o) => o.trip.legs.length > 0)
      } catch {
        markDown(network, clock())
      }
    }
    return []
  }

  private async startTransit(option: ConnectionOption) {
    if (!this.pendingTarget) return
    // Same origin and the trip's own departure time, so refreshes return this connection again
    const dep = option.trip.legs[0].from.scheduled
    const query: api.ConnectionQuery = { ...option.query, date: localDate(dep), time: hhmm(dep) }
    this.active = { target: this.pendingTarget, query, network: option.network.id, trip: option.trip, checkedInAt: clock(), fetchedAt: clock() }
    void saveCheckIn(this.active) // in the background: the journey screen must not wait for it
    fastForward()
    await this.showTransit()
  }

  private transitLayout() {
    return {
      textObject: [
        // Two containers, so the first line ends left of the clock and the second gets the full width
        this.text(1, 'hdr', 0, 32, ' ', false, { width: CLOCK_X, paddingLength: 2 }),
        this.text(2, 'steps', 136, 152, ' ', true, { paddingLength: 2 }),
        this.text(5, 'action', 32, 32, ' ', false, { paddingLength: 2 }),
      ],
      imageObject: [
        new ImageContainerProperty({ xPosition: 0, yPosition: 64, width: HALF_W, height: LINE_H, containerID: 3, containerName: 'lineL' }),
        new ImageContainerProperty({ xPosition: HALF_W, yPosition: 64, width: HALF_W, height: LINE_H, containerID: 4, containerName: 'lineR' }),
      ],
    }
  }

  private enterTransitMode() {
    this.stepOffset = -1
    this.lastDotX = -1
    this.mode = 'transit'
  }

  private async showTransit() {
    if (!this.active) return this.renderBoard()
    this.enterTransitMode()
    if (!(await this.rebuild(this.transitLayout()))) throw new Error('The glasses refused the journey page.')
    await this.renderTransit(true)
  }

  // ---------- In transit ----------

  private async refreshTrip() {
    const a = this.active
    if (!a) return
    try {
      const conns = await getNetwork(a.network ?? a.target.network).connections(a.query, 6)
      const match = conns.map(buildTrip).find((t) => t.signature === a.trip.signature)
      if (match) a.trip = match
      a.fetchedAt = clock()
      if (this.active === a) void saveCheckIn(a)
    } catch {
      // Offline: keep the last timetable, progress continues by the clock
    }
  }

  private async renderTransit(forceImage = false) {
    const a = this.active
    if (!a || this.mode !== 'transit') return
    const now = clock()
    const p = estimateProgress(a.trip, now, this.fix)

    const action = p.arrived ? `${nextAction(a.trip, p, now)} Tap: check out` : nextAction(a.trip, p, now)
    const { lines, currentLine } = tripSteps(a.trip, p)
    // Text must fit the container; overflowing text scrolls inside the firmware and eats swipes
    const rows = lines.length > STEP_ROWS ? STEP_ROWS - 1 : STEP_ROWS
    const maxOffset = Math.max(0, lines.length - rows)
    // Follow the current step unless the user scrolled recently
    if (this.stepOffset < 0 || now > this.stepScrolledUntil) this.stepOffset = currentLine
    this.stepOffset = Math.min(Math.max(0, this.stepOffset), maxOffset)
    let steps = lines.slice(this.stepOffset, this.stepOffset + rows).join('\n')
    if (maxOffset > 0) {
      const up = this.stepOffset > 0 ? '▲' : '△'
      const down = this.stepOffset < maxOffset ? '▼' : '▽'
      steps += `\n${' '.repeat(40)}${up}${down}`
    }

    // Before the text: drawing overlaps with the text transfers (images queue behind text anyway)
    const x = Math.round(dotX(a.trip, p))
    const ring = p.source === 'gps'
    const changed = Math.abs(x - this.lastDotX) >= 3 || ring !== this.lastRing
    if (forceImage || (changed && clock() - this.imageSentAt >= IMAGE_MIN_INTERVAL_MS)) {
      this.lastDotX = x
      this.lastRing = ring
      void this.sendImages()
    }

    await this.upgrade(1, 'hdr', tripHeader(a.target.label, a.trip, now))
    await this.upgrade(5, 'action', truncate(action, 52))
    await this.upgrade(2, 'steps', steps)
    this.status(`${a.target.label}: ${nextAction(a.trip, p, now)}`)
  }

  /** Requests during a transfer are not dropped: the newest state follows right after it. */
  private async sendImages() {
    if (!this.foreground) {
      this.lastDotX = -1 // sent on return to the foreground
      return
    }
    if (this.imageBusy) {
      this.imagePending = true
      return
    }
    this.imageBusy = true
    this.imagePending = false
    let failed = false
    try {
      const a = this.active
      if (!a || this.mode !== 'transit') return
      const p = estimateProgress(a.trip, clock(), this.fix)
      const [left, right] = await renderProgressPngs(a.trip, p)
      if ((await this.sendImage(3, 'lineL', left)) && (await this.sendImage(4, 'lineR', right))) {
        mark('journey line on screen')
        this.imageSentAt = clock()
        this.imageFailures = 0
      }
    } catch {
      failed = true
      this.imageFailures++
    } finally {
      this.imageBusy = false
    }
    if (this.imagePending) void this.sendImages()
    else if (failed) {
      this.lastDotX = -1 // the next tick tries again in any case
      if (this.imageFailures < 3) setTimeout(() => void this.sendImages(), 1000)
    }
  }

  /** Check out. */
  private async endTransit() {
    this.active = null
    this.pendingTarget = null
    void saveCheckIn(null)
    await this.renderBoard()
    await this.loadNearby()
  }

  // ---------- Timer ----------

  private async tick() {
    if (!this.foreground) return
    const now = clock()
    await this.updateClock()
    if (this.mode === 'board') {
      const preferred = this.fix && networkFor(this.settings.network, this.fix.lat, this.fix.lng)
      if (this.failover && preferred && !isDown(preferred, now)) await this.loadNearby() // back to the chosen network
      else if (now - this.boardFetchedAt > BOARD_REFRESH_MS) await this.loadBoard()
      else await this.renderBoard()
    } else if (this.mode === 'transit' && this.active) {
      if (checkInExpired(this.active, now, this.fix)) return this.endTransit()
      if (now - this.active.fetchedAt > TRIP_REFRESH_MS) {
        await this.refreshTrip()
        await this.renderTransit(true)
      } else {
        await this.renderTransit()
      }
    }
  }

  // ---------- Input ----------

  private async onEvent(e: EvenHubEvent) {
    const sys = e.sysEvent
    if (sys) {
      if (sys.eventType === OsEventTypeList.IMU_DATA_REPORT) {
        if (logImu) console.log('[imu]', sys.imuData?.x, sys.imuData?.y, sys.imuData?.z)
        return
      }
      const type = sys.eventType ?? OsEventTypeList.CLICK_EVENT
      switch (type) {
        case OsEventTypeList.FOREGROUND_ENTER_EVENT:
          this.foreground = true
          this.lastDotX = -1
          await this.startLocation()
          return this.tick()
        case OsEventTypeList.FOREGROUND_EXIT_EVENT:
          this.foreground = false
          return
        case OsEventTypeList.ABNORMAL_EXIT_EVENT:
        case OsEventTypeList.SYSTEM_EXIT_EVENT:
          return this.stop()
        case OsEventTypeList.CLICK_EVENT:
          return this.onClick()
        case OsEventTypeList.DOUBLE_CLICK_EVENT:
          return this.onDoubleClick()
        case OsEventTypeList.SCROLL_TOP_EVENT:
          return this.onScroll(-1)
        case OsEventTypeList.SCROLL_BOTTOM_EVENT:
          return this.onScroll(1)
      }
      return
    }
    if (e.textEvent) {
      const type = e.textEvent.eventType
      if (type === OsEventTypeList.SCROLL_TOP_EVENT) return this.onScroll(-1)
      if (type === OsEventTypeList.SCROLL_BOTTOM_EVENT) return this.onScroll(1)
      if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) return this.onDoubleClick()
      return
    }
    if (e.listEvent) {
      const type = e.listEvent.eventType ?? OsEventTypeList.CLICK_EVENT
      if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) return this.onDoubleClick()
      if (type === OsEventTypeList.CLICK_EVENT) return this.onListSelect(e.listEvent.currentSelectItemIndex ?? 0)
    }
  }

  private async onClick() {
    switch (this.mode) {
      case 'board':
        return this.showTargets()
      case 'message':
        // Back to the journey when checked in, else to the board
        return this.active ? this.showTransit() : this.renderBoard()
      case 'transit':
        if (this.active?.trip && estimateProgress(this.active.trip, clock(), this.fix).arrived) {
          return this.endTransit()
        }
        await this.refreshTrip()
        return this.renderTransit(true)
    }
  }

  private async onDoubleClick() {
    switch (this.mode) {
      case 'loading':
      case 'board':
      case 'message':
        await serial(() => this.bridge.shutDownPageContainer(1))
        return
      case 'targets':
        return this.renderBoard()
      case 'connections':
        return this.showTargets()
      case 'transit':
        this.mode = 'confirmStop'
        await this.showList(`Checked in → ${truncate(this.active?.target.label ?? '', 26)}`, [...CONFIRM_ITEMS])
        return
      case 'confirmStop':
        return this.showTransit()
    }
  }

  private async onScroll(dir: number) {
    if (this.mode === 'board') return this.switchStation(dir)
    if (this.mode === 'transit') {
      this.stepOffset = Math.max(0, this.stepOffset + dir * (STEP_ROWS - 1))
      this.stepScrolledUntil = clock() + 30_000
      return this.renderTransit()
    }
  }

  private async onListSelect(index: number) {
    if (this.mode === 'targets') {
      const t = this.targets[index]
      return t ? this.pickTarget(t) : this.renderBoard()
    }
    if (this.mode === 'connections') {
      const o = this.options[index]
      return o ? this.startTransit(o) : this.showTargets()
    }
    if (this.mode === 'confirmStop') {
      if (index === 1) return this.closeApp()
      if (index === 2) return this.endTransit()
      return this.showTransit()
    }
  }

  /** Leave the app but stay checked in; the next start opens the journey again. */
  private async closeApp() {
    if (this.active) await saveCheckIn(this.active)
    this.stop()
    await serial(() => this.bridge.shutDownPageContainer(0)).catch(() => false)
  }
}
