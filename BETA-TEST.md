# Simple public transit: private beta

Tester account: `dominik.fahrni@gmail.com` (must be the account signed in to the Even Realities App on the test phone).

## 1. One-time setup

1. Glasses paired in the Even Realities App, firmware up to date (Devices → Firmware).
2. Log in at <https://hub.evenrealities.com/login> with `dominik.fahrni@gmail.com` (turns on Developer Mode), then force-quit and reopen the phone app.
3. In this folder, sign in the CLI once (asks for the password):
   ```bash
   npx evenhub login
   ```

## 2. Release a beta build

```bash
scripts/beta-release.sh "what changed"
```

It type-checks, runs the tests, builds `icon.png` and `simple-public-transit.ehpk`, creates the app (first run) or uploads a new version, promotes it to **beta** and invites the tester.
For every later build raise `"version"` in `app.json` first (currently `0.7.0`, next e.g. `0.7.1`); a version number can only be uploaded once.

Then manually:

1. Open the invitation email on `dominik.fahrni@gmail.com` and accept it.
2. Check that both gates hold (otherwise the phone says "test version expired"):
   ```bash
   npx evenhub ls com.dominikfahrni.simplepublictransit   # CHANNEL: beta
   npx evenhub testers                                   # status: Active
   ```
3. Phone: **Even Realities App → Me → Beta tester → Simple public transit → Install**.
4. Allow location access when asked.

## 3. Test checklist

Setup on the phone (open the app from the phone app)
- [ ] Add 2–3 targets: one station (e.g. "Zürich HB"), one address, one far away (e.g. "Thun").
- [ ] Reorder and delete a target; changes appear in the glasses target list.

Data sources & licences (phone)
- [ ] Section lists all sources with working links; "Licence text" opens the MIT texts.
- [ ] Glasses map shows "© OSM" in the top right corner (readable?).

Settings (phone)
- [ ] Network "Automatic" picks International (Transitous) everywhere; in CH, Switzerland & cross-border takes over when Transitous fails (try `?fail=api.transitous.org`). Forcing a network reloads the board.
- [ ] Map checkbox off → board uses the full width; on → map is back.

Speed (0.3.1)
- [ ] The "app starting" notice on the glasses disappears quickly (first page is drawn before anything else loads).
- [ ] Second start within 20 min: last board appears at once, departures refresh within a second or two.
- [ ] First start / after a long break: board appears within a few seconds (coarse position first).
- [ ] Swiping between stops is instant (except the first seconds after start).
- [ ] Journey line appears together with the text (also when reopening a checked-in journey), not seconds later.
- [ ] Dot moves steadily by the clock; with GPS it only jumps when the train is clearly late/early (≥ 1.5 min).
- [ ] Standing still: taps react immediately, map is not redrawn all the time.

Departure board (start from the **glasses menu**)
- [ ] Shows the closest stop with distance and correct local time.
- [ ] Columns line up: minutes · line (Tram/Bus/S/IC…) · → destination · platform/delay.
- [ ] Swipe up/down switches between nearby stops; board refreshes on its own (~30 s).
- [ ] Walk 200 m: the stop list updates.
- [ ] No scrollbar on the right of any column (text fits).
- [ ] Map: hollow square = selected stop, filled dot = you, small rings = other nearby stops, dotted line between you and the stop.
- [ ] Swiping: text under the map reads "Map updating…" until the new map arrives, then the walking time again; the stop number in the map corner (e.g. 2/6) matches the header.
- [ ] Map follows when you walk (redraws every ~25 m, at most every 15 s) and when you swipe to another stop; "n m NE · n' walk" under it is right.
- [ ] Streets are readable on the glasses (not too bright/dim). Map without streets = tile download failed (still shows stops and you).

Germany (needs a German location, or the network set to "Automatic" or "International")
- [ ] Add a German target (network "International" in Add target), e.g. "Berlin Südkreuz".
- [ ] Board shows S/U-Bahn, tram and bus lines with destination, platform where available, delays.
- [ ] Navigation works, a change with a walk between platforms shows "Change at … (n', walk n')".

Navigation
- [ ] Tap → targets; pick one → up to 5 connections with times, duration, changes, lines.
- [ ] Double tap goes back from both lists.
- [ ] Pick a connection: header shows destination, arrival, time left, next action.
- [ ] Journey line appears (two halves join seamlessly), dot at the start.
- [ ] Every change shows arrival platform → departure platform with times; platform changes marked `!`.
- [ ] During the ride: dot moves; an outer ring around the dot means GPS is steering it.
- [ ] Train late/standing: dot follows GPS, not the clock.
- [ ] Delays appear (`+2'`) after a tap or within a minute.
- [ ] At a change: "Board … Pl x in n'" and the dot sits in the station capsule.
- [ ] Swipe scrolls the steps; after 30 s it jumps back to the current step.
- [ ] Double tap → "Checked in → …" with Continue journey / Close app · stay checked in / Check out.
- [ ] Phone app shows a "Checked in" card with arrival time and a Check out button.

Check-in (long journeys)
- [ ] Close app · stay checked in → app closes. Start it again: the journey is there at once (no "Locating…"), delays update a moment later.
- [ ] Same after a phone restart / force-quit of the Even app.
- [ ] Check out (glasses or phone card) → board; next start opens the board.
- [ ] After arrival: "Arrived at … Tap: check out"; tap returns to the board.
- [ ] Not tapping: about 10 min after arrival the app checks out by itself (GPS at the destination or timetable refreshed), at the latest 1 h after the last known arrival. Same when the app was closed during arrival: next start shows the board.

Lifecycle (what the Even QA review checks)
- [ ] Lock the phone for **5 minutes** on the board, unlock: app still there and updating.
- [ ] Same during navigation: progress continues, GPS ring returns.
- [ ] Force-quit the Even app during navigation and relaunch Simple public transit: navigation resumes.
- [ ] Double tap on the board → system exit dialog; Cancel keeps the app, Confirm exits.
- [ ] Flight mode on the board: "Offline · retrying", recovers when back online.

## Notes for the report

Photos of the glasses (or the phone's developer console) help most for: wrapped/cut text, image line not showing, dot jumping, wrong platform/time.
