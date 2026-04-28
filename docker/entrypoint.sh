#!/bin/bash
set -e

# If Docker created ~/.pi as a root-owned empty dir (host dir didn't exist),
# fix ownership so Pi can use it.
PI_HOME="$HOME/.pi"
if [ -d "$PI_HOME" ] && [ ! -w "$PI_HOME" ]; then
    # We can't chown without root — create a fallback inside the writable home
    export PI_HOME="$HOME/.pi-local"
    mkdir -p "$PI_HOME"
fi

PROFILE=${PI_PROFILE:-default}
SRC="/app/.pi/profiles/$PROFILE/settings.json"
DST="/app/.pi/settings.json"

if [ -f "$SRC" ]; then
    # Use -f to force overwrite and handle potential permission/same-file issues
    # We remove it first just in case it's owned by root from a previous run
    rm -f "$DST"
    cp "$SRC" "$DST"
fi

exec pi "$@"
