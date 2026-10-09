FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npx tsc --noEmit

# Authenticated server: fails closed without a token source
# (OPEN_BRAIN_HTTP_TOKEN_FILE: absolute path to an owner-only file with 64 hex chars,
# owned by the container user). It binds 127.0.0.1 only, so it is reachable only with
# host networking (Linux `docker run --network host`), not through a published port.
CMD ["node", "--import", "tsx/esm", "src/server-hardened.ts"]
