FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig*.json ./
COPY src ./src
COPY tests ./tests
COPY scripts ./scripts
RUN npm run build && npm test

FROM build AS verification
COPY db ./db
CMD ["sh", "-c", "npm run test:integration && node --input-type=module -e \"import pg from 'pg'; const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL}); for (const schema of ['haim','haim_core_test','haim_core_test_jobs']) await pool.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); await pool.end();\" && npm run test:regressions && npm run test:golden"]

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-tests ./dist-tests
COPY db ./db
COPY scripts ./scripts
RUN mkdir -p /data/haim-yahad-media && chown -R node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=180s --retries=3 CMD ["node","-e","fetch('http://127.0.0.1:3000/health',{signal:AbortSignal.timeout(8000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/server.js"]
