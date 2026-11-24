#!/bin/sh
# Each benchmark gets a fresh process and OS peak-RSS measurement.
set -u
cd "$(dirname "$0")/../../.." || exit 2
tsx=packages/planner/node_modules/.bin/tsx
script=packages/planner/scripts/whole-map-real.ts
status=0
if [ "$#" -eq 0 ]; then
  set -- CA TX FL PA HI ME RI PA-house
fi
for scenario; do
  case "$scenario" in
    PA-house) set -- PA 4 1 data/PA/fixtures/sldl2022.csv D20FA ;;
    CA) set -- CA 4 1 data/CA/fixtures/cd119.csv D20FA ;;
    CA-census) set -- CA 4 1 ;;
    *) set -- "$scenario" 4 1 ;;
  esac
  /usr/bin/time -l "$tsx" "$script" "$@" || status=1
done
exit "$status"
