#!/bin/bash
# Installs the robotstxt-proxy CA certificate into Chromium's NSS database
# before starting the browser. Runs as seluser (non-root), so we use certutil
# to import into ~/.pki/nssdb — the only CA store Chromium on Linux actually reads.
set -e

CA_FILE=/tmp/ca/ca.crt

echo "[chrome-init] Waiting for CA certificate at $CA_FILE ..."
for i in $(seq 1 60); do
  [ -f "$CA_FILE" ] && break
  sleep 1
done

if [ -f "$CA_FILE" ]; then
  NSSDB="/home/seluser/.pki/nssdb"
  mkdir -p "$NSSDB"
  # Create a new NSS database if one doesn't exist yet.
  certutil -N --empty-password -d "sql:$NSSDB" 2>/dev/null || true
  # Import the CA; CT,, = trusted CA for TLS.
  certutil -A -n "robotstxt-proxy" -t "CT,," -i "$CA_FILE" -d "sql:$NSSDB"
  echo "[chrome-init] CA certificate imported into NSS database."
else
  echo "[chrome-init] WARNING: CA certificate not found after 60 s — HTTPS sites will show cert errors."
fi

exec /opt/bin/entry_point.sh "$@"
