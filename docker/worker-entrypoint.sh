#!/bin/sh
# The worker container (docs/design.md §6): a virtual display for headed Chromium, the live view on it, then the worker.
#   Xvfb :99        the display headed runs draw on
#   fluxbox         a window manager, so Chromium opens maximized
#   x11vnc          the display over VNC, on localhost only, with two passwords: VNC_PASSWORD (full control) and
#                   VNC_VIEW_PASSWORD (view-only: x11vnc ignores input); the password file is deleted once read
#   websockify      VNC over a WebSocket on 6080, which Caddy serves at /vnc after checking the session
set -eu

Xvfb :99 -screen 0 1600x1000x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
for _ in $(seq 1 50); do
  [ -e /tmp/.X11-unix/X99 ] && break
  sleep 0.1
done
fluxbox >/tmp/fluxbox.log 2>&1 &

if [ -n "${VNC_PASSWORD:-}" ] && [ -n "${VNC_VIEW_PASSWORD:-}" ]; then
  umask 077
  printf '%s\n__BEGIN_VIEWONLY__\n%s\n' "$VNC_PASSWORD" "$VNC_VIEW_PASSWORD" >/tmp/vnc.pass
  x11vnc -display :99 -rfbport 5900 -localhost -forever -shared -passwdfile rm:/tmp/vnc.pass -noxdamage -quiet \
    >/tmp/x11vnc.log 2>&1 &
  websockify 0.0.0.0:6080 127.0.0.1:5900 >/tmp/websockify.log 2>&1 &
else
  echo "VNC_PASSWORD or VNC_VIEW_PASSWORD is not set: no live view" >&2
fi

exec node dist/main.js
