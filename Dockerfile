FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npx tsc --noEmit

USER node
EXPOSE 3100

# Authenticated server; fails closed without a token source
# (OPEN_BRAIN_HTTP_TOKEN_FILE: absolute path to an owner-only file with 64 hex chars,
# owned by the container user). Default bind is 127.0.0.1; a container that should be
# reachable sets OPEN_BRAIN_BIND_HOST=0.0.0.0 together with OPEN_BRAIN_ALLOWED_HOSTS
# (docker-compose.yml, profile "app").
CMD ["node", "--import", "tsx/esm", "src/server-hardened.ts"]
