FROM mcr.microsoft.com/playwright:v1.56.1-noble
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY smoke.mjs ./
COPY e2e-load-100.mjs ./
CMD ["node", "smoke.mjs"]
