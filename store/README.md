# Store listing assets

Upload in the developer portal: <https://hub.evenrealities.com> → Simple euro transit → listing → product screenshots.
The `evenhub` CLI cannot upload screenshots (it only updates name, tagline, description and icon).

- `screenshots/`: for the listing. 576×288, glasses display on black.
- `raw/`: the original simulator output (RGBA, transparent background), as captured.

Captured from the Even Hub simulator (`/api/screenshot/glasses`) with live timetable data on 2026-11-09 (01: with platform labels, later the same day), as the
submission guidelines ask ("Screenshots match what the app actually renders on device").
To redo the black versions after new captures: `node scripts/flatten-screenshots.mjs store/raw store/screenshots`.

| File | Caption |
|---|---|
| 01-departures-zurich.png | Departures of the closest stop with line, destination, platform and delay, plus a street map showing where the stop is and which side of the street each departure leaves from. |
| 02-departures-berlin.png | Works in Germany too: S-Bahn, U-Bahn, tram and bus in Berlin. |
| 03-targets.png | Your preset targets, set up in the phone app. |
| 04-connections.png | Pick a connection: times, duration, changes and lines. |
| 05-journey-start.png | Your journey as a line: every change with time and platform. |
| 06-journey-on-the-way.png | On the way: the dot shows how far along you are, including delays. |
| 07-journey-change.png | At a change: which train, which platform, how many minutes. |
| 08-check-in-menu.png | Check in: close the app on long rides and get straight back to your journey. |
