# 1xOps Command Center in a container: it sees only the folders you mount at /workspace.
# Base: Chainguard Wolfi, pinned by digest (2026-11-16, 0 critical/high CVEs by docker scout).
# Refresh the digest when a scan flags the base. Node 24 and ripgrep come from Wolfi's own
# packages. The server runs as a non-root user with production dependencies only.
#
#   docker build -t command-center:0.4.1 mcp-server
#   docker run -i --rm -v "$PWD:/workspace" command-center:0.4.1
ARG WOLFI_BASE=cgr.dev/chainguard/wolfi-base:latest@sha256:833c48f1faf32c90e6f9501a2410a9aa28ceb2c594102edd4470053c30efa089

FROM ${WOLFI_BASE} AS build
RUN apk add --no-cache nodejs-24 npm
WORKDIR /src
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev

FROM ${WOLFI_BASE}
RUN apk add --no-cache nodejs-24 ripgrep \
 && adduser -D -h /home/command-center -u 10001 command-center \
 && mkdir -p /workspace && chown command-center /workspace
WORKDIR /app
COPY --from=build /src/package.json ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY LICENSE ./
USER command-center
WORKDIR /workspace
ENV COMMAND_CENTER_CONFIG_DIR=/home/command-center/.command-center
LABEL org.opencontainers.image.title="1xOps Command Center" \
      org.opencontainers.image.source="https://github.com/1xOps/command-center" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.authors="1xOps (nnthanh101) <nnthanh101@gmail.com>"
ENTRYPOINT ["node", "/app/dist/index.js", "/workspace"]
