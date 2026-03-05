FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npx tsc --noEmit

EXPOSE 3100

CMD ["node", "--import", "tsx/esm", "src/server.ts"]
