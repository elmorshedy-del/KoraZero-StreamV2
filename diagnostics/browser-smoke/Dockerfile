FROM mcr.microsoft.com/playwright:v1.56.1-noble
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY smoke.mjs ./
CMD ["node", "smoke.mjs"]
