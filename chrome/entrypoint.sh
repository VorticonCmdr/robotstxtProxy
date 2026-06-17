#!/bin/bash
# Installs the robotstxt-proxy CA certificate before Chrome starts.
#
# The proxy generates certs/ca.crt on first run (before it starts listening).
# By the time this container starts (depends_on: service_healthy), the cert
# should already exist — but we wait up to 60s just in case.
set -e

CA_FILE=/tmp/ca/ca.crt

echo "[chrome-init] Waiting for CA certificate at $CA_FILE ..."
for i in $(seq 1 60); do
  [ -f "$CA_FILE" ] && break
  sleep 1
done

if [ -f "$CA_FILE" ]; then
  echo "[chrome-init] Installing CA into system trust store ..."
  cp "$CA_FILE" /usr/local/share/ca-certificates/robotstxt-proxy.crt
  update-ca-certificates

  # Chrome on Linux uses NSS (libnss3), not the system CA store, so we also
  # import into the user's NSS database.
  NSSDB="/home/seluser/.pki/nssdb"
  mkdir -p "$NSSDB"
  certutil -N --empty-password -d "sql:$NSSDB" 2>/dev/null || true
  certutil -A -n "robotstxt-proxy" -t "CT,," -i "$CA_FILE" -d "sql:$NSSDB"
  echo "[chrome-init] CA certificate installed successfully."
else
  echo "[chrome-init] WARNING: CA certificate not found after 60 s. HTTPS sites will show cert errors."
fi

exec /opt/bin/entry_point.sh "$@"
