FROM node:20-bookworm-slim AS base
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci

FROM base AS build
COPY . .
RUN npm run build -w @vectoree-starter/web

FROM base AS server
COPY apps/server apps/server
ENV HOST=0.0.0.0
ENV PORT=8787
EXPOSE 8787
CMD ["npm", "run", "start", "-w", "@vectoree-starter/server"]

FROM build AS web
ENV API_PROXY=http://server:8787
EXPOSE 5173
CMD ["npm", "run", "preview", "-w", "@vectoree-starter/web", "--", "--host", "0.0.0.0", "--port", "5173", "--strictPort"]
