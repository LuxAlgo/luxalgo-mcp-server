# LuxAlgo MCP in a container: the local stdio server (what `npx -y @luxalgo/mcp`
# runs), built from this repository. MCP directories such as Glama build this
# image and introspect the running server over stdio.
#
#   docker build -t luxalgo-mcp .
#   docker run -i --rm luxalgo-mcp
#
# Every keyless tool works as is. The broker tools read BROKERS_* variables
# (docker run -i --rm -e BROKERS_ALPACA_API_KEY=... luxalgo-mcp); see README.

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: `prepare` runs the TypeScript build, and src/ is not here yet.
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY LICENSE NOTICE ./
USER node
# package.json "bin" (luxalgo-mcp) and "main": dist/index.js, the stdio entry.
CMD ["node", "dist/index.js"]
