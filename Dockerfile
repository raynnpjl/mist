FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV IMPER_CACHE_DIR=/opt/mist-curl
COPY package*.json ./
RUN npm ci && node --input-type=module -e "const {isUsingImpersonate}=await import('impers'); if(!await isUsingImpersonate()) throw Error('curl-impersonate unavailable')"
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates ffmpeg && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production PORT=7000 IMPER_CACHE_DIR=/opt/mist-curl
COPY --from=build /opt/mist-curl /opt/mist-curl
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./public
USER node
EXPOSE 7000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
