# ---- build stage ----
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage ----
FROM node:20-slim AS runtime
# Containers must listen on all interfaces. Combined with NODE_ENV=production
# this makes MCP_API_KEY mandatory (the server refuses to start without it).
ENV NODE_ENV=production
ENV HOST=0.0.0.0
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# Persist linked-item tokens across restarts by mounting a volume here.
VOLUME ["/app/data"]
EXPOSE 3000
CMD ["node", "dist/index.js"]
