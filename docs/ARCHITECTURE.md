# Architecture

Simple transit is a plain TypeScript web app (no framework) that runs in the Even Realities
app's WebView on the phone. The same page is the phone settings screen and the controller of the
glasses: it talks to the glasses through the Even Hub SDK bridge, which forwards every call over
Bluetooth.

```
 timetable APIs ──HTTP──▶  WebView on the phone  ──Even Hub bridge / Bluetooth──▶  G2 glasses
 (transport.opendata.ch,    ├─ companion.ts  phone page (settings, targets, credits)
  api.transitous.org)       └─ glasses.ts    everything shown on the glasses
```

## Modules

| File | Role |
|---|---|
| `main.ts` | Entry point. Starts the glasses side first, then the phone page. |
| `glasses.ts` | State machine for the glasses: board, target and connection lists, journey, check-in menu. Builds the pages, handles taps and swipes, timers, GPS. |
| `companion.ts` | Phone page: settings, target search and list, check-in card, credits. |
| `bridge.ts` | Bridge access: one-call-at-a-time queue with timeouts and two priorities; persistent storage (Even app storage, mirrored into WebView storage). |
| `api.ts` | Swiss client (transport.opendata.ch) and the shared data model all networks return. |
| `networks/` | Network registry, automatic selection by position, and the Transitous adapter that converts MOTIS responses into the shared model. |
| `journey.ts` | Trip model built from a connection, and progress estimation (clock first, GPS as correction). |
| `checkin.ts` | Saved journey and the rules for automatic check-out. |
| `format.ts` | All text shown on the glasses (board rows, steps, next action). |
| `line-layout.ts`, `progress-image.ts` | Journey line: schematic layout with minimum segment widths, drawn on a canvas, split into two 288 px images. |
| `map/` | Board map: Web Mercator view, vector tile decoder (`mvt.ts`), drawing. |
| `credits.ts` | Data sources, services and licences shown on the phone page. |
| `http.ts`, `canvas.ts` | Fetch with timeout; canvas to PNG bytes. |
| `dev.ts` | Test parameters for the dev server and simulator (ignored in production builds). |

## Constraints that shaped the code

**Bluetooth is the bottleneck.** Every text update and image goes from the phone to the glasses
one at a time; an image transfer takes seconds on real hardware. Hence:

- text already on screen is never sent again (`GlassesApp.upgrade` remembers what each container shows);
- distances are rounded so GPS jitter doesn't change the text;
- images go through a low-priority lane of the bridge queue, so text and taps never wait behind them;
- map and journey line are redrawn only when they changed, throttled, latest state wins;
- the first page is built from local copies only, so the Even app's "app starting" notice
  disappears without waiting for storage, GPS or the network.

**The glasses display** is 576×288 px, greyscale, with a proportional firmware font and at most
12 containers per page (8 text/list, 4 images, each image at most 288×144). The departure table
is therefore four text containers side by side (one per column), and the journey line is two
images.

**Startup and lifecycle.** The WebView can be suspended or killed at any time (phone locked, app
in the background). The last departure board and the check-in are stored, so the app opens with
something useful immediately and resumes a journey after a restart; location updates are
restarted whenever the app comes back to the foreground.

## Data flow

1. Position → `networkFor()` picks the network → `nearbyStations()` → `stationboard()` for the
   selected stop (the other nearby stops are prefetched for instant swiping).
2. Target → `connections()` from the current position → `buildTrip()` → check-in → journey view.
3. While travelling: every 10 s the view is re-rendered from the clock; every 60 s the timetable is
   refreshed and the same connection is found again by its signature (lines + departure times).

## Adding a network

Implement `Network` (`networks/types.ts`) by converting the provider's responses into the shapes
in `api.ts` (`networks/transitous.ts` is a complete example), register it in
`networks/index.ts`, add the API origin to the network whitelist in `app.json` and the data
sources and licences to `credits.ts`.

## Tests

`npm test` runs unit tests against recorded API responses in `src/__fixtures__/` (Swiss
connection and departures, Transitous plan, stop times and stops, one vector tile): trip building,
progress and GPS rules, line layout, the Transitous conversion, map framing and the check-in
expiry. The glasses UI is tested by hand in the simulator and on the device (`BETA-TEST.md`).
