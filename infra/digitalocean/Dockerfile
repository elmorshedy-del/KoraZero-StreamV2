FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY --chown=node:node package.json ./
COPY --chown=node:node server ./server
COPY --chown=node:node src ./src

USER node
CMD ["node", "server/index.js"]
