FROM node:lts-alpine

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json package-lock.json* ./
# Include optional deps (node-forge) so MITM mode works out of the box.
RUN npm ci --omit=dev || npm install --omit=dev

COPY src ./src

# robots.txt CA persists here when HTTPS_MODE=mitm (mount a volume in production).
RUN mkdir -p /app/certs && chown -R node:node /app
USER node

EXPOSE 8080
ENV PORT=8080 HOST=0.0.0.0

CMD ["node", "src/server.js"]
