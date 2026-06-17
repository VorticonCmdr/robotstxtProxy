# Multi-arch: seleniarm/standalone-chromium publishes linux/arm64 + linux/amd64 manifests.
# Docker Desktop pulls the native variant automatically (no --platform flag needed).
FROM seleniarm/standalone-chromium:latest

USER root

# libnss3-tools provides certutil for importing the CA into Chrome's NSS database.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3-tools \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Chrome Managed Policy: sets the proxy for all sessions, including the noVNC browser.
# This is the only reliable way to proxy Chrome — SE_OPTS targets the Selenium Java
# process, not the browser.
RUN mkdir -p /etc/chromium-browser/policies/managed
COPY policy.json /etc/chromium-browser/policies/managed/proxy.json

COPY entrypoint.sh /usr/local/bin/chrome-entrypoint.sh
RUN chmod +x /usr/local/bin/chrome-entrypoint.sh

USER seluser

# Pre-create the NSS database so the runtime certutil -A (cert import) is instant.
# Creating the database is CPU-intensive due to entropy seeding — doing it at build
# time avoids a multi-minute hang when the container starts in Docker Desktop.
RUN mkdir -p /home/seluser/.pki/nssdb && \
    certutil -N --empty-password -d "sql:/home/seluser/.pki/nssdb"

ENTRYPOINT ["/usr/local/bin/chrome-entrypoint.sh"]
