FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig*.json ./
COPY src ./src
COPY tests ./tests
COPY scripts ./scripts
COPY config ./config
RUN npm run build && npm test

FROM build AS verification
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
  && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /etc/apt/trusted.gpg.d/pgdg.gpg \
  && echo "deb http://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client-17 \
  && rm -rf /var/lib/apt/lists/*
COPY db ./db
CMD ["sh", "-c", "npm run test:t21-t22 && npm run test:ai-eval-contract && npm run check:ai-eval && npm run test:integration && npm run test:t24-shadow && node scripts/test-sheets-import.mjs && node scripts/prepare-backup-drill.mjs && DATABASE_URL=\"$BACKUP_DRILL_TARGET_URL\" DB_SCHEMA=haim_core_test BOT_MODE=shadow NODE_ENV=test AI_ENABLED=false WAHA_WEBHOOK_HMAC_KEY=disposable-test-only-0000000000000000 HAIM_ADMIN_TOKEN=disposable-test-only-admin-token-000000000000 node dist/db/migrate-cli.js && DRILL_CONFIRM=YES DISPOSABLE_RESTORE=YES BACKUP_DB_SCHEMA=haim_core_test BACKUP_MEDIA_ROOT=/app/backup-media BACKUP_CONFIGURATION_FILE=/app/scripts/backup-drill-config.json BACKUP_DRILL_DIR=/app/artifacts/qa/t21-t22-backup-drill node scripts/backup-restore-drill.mjs \"$BACKUP_DRILL_SOURCE_URL\" \"$BACKUP_DRILL_TARGET_URL\" && node --input-type=module -e \"import pg from 'pg'; const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL}); for (const schema of ['haim','haim_core_test','haim_core_test_jobs']) await pool.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); await pool.end();\" && npm run test:regressions && npm run test:golden"]

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-tests ./dist-tests
COPY db ./db
COPY scripts ./scripts
COPY config ./config
RUN mkdir -p /data/haim-yahad-media && chown -R node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=180s --retries=3 CMD ["node","-e","fetch('http://127.0.0.1:3000/health',{signal:AbortSignal.timeout(8000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/server.js"]
