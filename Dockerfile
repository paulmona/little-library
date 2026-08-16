FROM node:24-slim

ENV NODE_ENV=production

WORKDIR /app

# Dependencies first so a source-only change does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src/ ./src/

# The catalogue is the deployment's data and never belongs in the image. The
# app creates the directory on first run, so an empty mount is a valid start.
ENV DATABASE_PATH=/data/library.db
VOLUME ["/data"]

ENV PORT=8080
EXPOSE 8080

# /health also reports which integrations are configured, but a 200 is enough
# to know the server is up and the database opened.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
