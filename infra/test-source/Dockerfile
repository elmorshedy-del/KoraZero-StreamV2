FROM node:24-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app
COPY infra/test-source/server.mjs ./server.mjs

ENV PORT=8080
CMD ["node", "server.mjs"]
