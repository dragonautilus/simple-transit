#!/usr/bin/env bash
# Builds, uploads and promotes Simple transit to the Even Hub beta channel and invites the
# tester. Safe to re-run: existing app -> upload, existing tester -> skipped.
#
# Usage: scripts/beta-release.sh ["what changed"]
# Needs: `npx evenhub login` done once in this terminal (interactive, not scriptable).

set -euo pipefail
cd "$(dirname "$0")/.."

TESTER="dominik.fahrni@gmail.com"
NAME="Simple transit"
TAGLINE="Live departures and transit on your glasses"
CHANGES="${1:-Beta build}"

PKG=$(node -p "require('./app.json').package_id")
VERSION=$(node -p "require('./app.json').version")
EHPK="simple-transit.ehpk"
evenhub() { npx --no-install evenhub "$@"; }

echo "== $NAME $VERSION ($PKG)"
if [ ${#TAGLINE} -gt 50 ]; then echo "Tagline is ${#TAGLINE} characters, max 50." >&2; exit 1; fi

echo "== Checks"
npx tsc --noEmit -p .
npm test --silent
npm run icon --silent >/dev/null
npm run pack --silent

echo "== Account"
if ! evenhub self-check; then
  echo "Not signed in. Run: npx evenhub login   (then re-run this script)" >&2
  exit 2
fi

echo "== Upload"
set +e
evenhub ls "$PKG" >/dev/null 2>&1
exists=$?
set -e
if [ "$exists" -eq 3 ]; then
  evenhub create "$EHPK" --name "$NAME" --tagline "$TAGLINE" \
    --description-file store-description.md --icon icon.png
else
  set +e
  evenhub upload "$EHPK" -m "$CHANGES"
  code=$?
  set -e
  if [ "$code" -eq 4 ]; then
    echo "Version $VERSION already uploaded. Raise \"version\" in app.json and re-run." >&2
    exit 4
  elif [ "$code" -ne 0 ]; then
    exit "$code"
  fi
fi

echo "== Beta channel"
evenhub promote "$VERSION" --to beta

echo "== Tester"
evenhub testers add "$TESTER"

echo "== Status"
evenhub ls "$PKG"
evenhub testers --search "$TESTER"

cat <<EOF

Done. Remaining manual steps:
  1. $TESTER: open the invitation email and accept it (tester status must read Active).
  2. Phone: Even Realities App -> Me -> Beta tester -> $NAME -> Install.
  3. Start it from the glasses menu or the phone app. Checklist: BETA-TEST.md
EOF
