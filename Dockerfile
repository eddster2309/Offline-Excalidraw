# syntax=docker/dockerfile:1
# Offline Excalidraw: patched app + self-hosted collab/storage server.
# Network is needed only while building this image.

# Base images: BASE_REGISTRY=$HARBOR_DOCKER pulls through the Harbor Docker Hub proxy.
# DLCACHE_URL / npm_config_registry (optional, passed automatically by the CI
# docker-build component) route the source tarballs and npm/yarn packages through
# the download cache; unset, everything goes to github.com / registry.yarnpkg.com.
ARG BASE_REGISTRY=docker.io

# ---- stage 1: build the patched Excalidraw app
FROM ${BASE_REGISTRY}/library/node:22 AS app
ARG DLCACHE_URL
ARG npm_config_registry
ARG UPSTREAM_REPO=https://github.com/excalidraw/excalidraw.git
ENV UPSTREAM_REPO=${UPSTREAM_REPO} GIT_COMMITTER_NAME=builder GIT_COMMITTER_EMAIL=builder@localhost \
    GIT_AUTHOR_NAME=builder GIT_AUTHOR_EMAIL=builder@localhost
WORKDIR /src
COPY UPSTREAM_COMMIT ./UPSTREAM_COMMIT
COPY patches ./patches
COPY scripts ./scripts
RUN ./scripts/apply-patches.sh /src/upstream
WORKDIR /src/upstream
# yarn 1 ignores npm_config_registry for URLs pinned in yarn.lock: rewrite them
# to the cache registry (when set), then restore the lockfile.
RUN if [ -n "$npm_config_registry" ]; then sed -i "s#https://registry.yarnpkg.com/#${npm_config_registry%/}/#g" yarn.lock; fi && \
    yarn install --frozen-lockfile --network-timeout 300000 && \
    git checkout -- yarn.lock
RUN yarn build:app:docker

# ---- stage 2: offline library site (mirror of libraries.excalidraw.com)
# Skip with: docker build --build-arg INCLUDE_LIBRARIES=false .
# (/libraries then returns 404 and publishing is disabled; the rest of the app is unaffected)
FROM ${BASE_REGISTRY}/library/node:22 AS libs
ARG DLCACHE_URL
ARG INCLUDE_LIBRARIES=true
ARG LIBRARIES_REPO=https://github.com/excalidraw/excalidraw-libraries.git
ENV LIBRARIES_REPO=${LIBRARIES_REPO} GIT_COMMITTER_NAME=builder GIT_COMMITTER_EMAIL=builder@localhost \
    GIT_AUTHOR_NAME=builder GIT_AUTHOR_EMAIL=builder@localhost
WORKDIR /src
COPY LIBRARIES_COMMIT ./LIBRARIES_COMMIT
COPY patches-libraries ./patches-libraries
COPY scripts ./scripts
RUN mkdir -p /out/libraries && \
    if [ "$INCLUDE_LIBRARIES" = "true" ]; then \
      ./scripts/apply-libraries-patches.sh /src/libraries-upstream && \
      cd /src/libraries-upstream && \
      cp -r index.html script.js style.css favicon.ico LICENSE libraries.json stats.json total.json vendor libraries /out/libraries/; \
    fi

# ---- stage 3: runtime
FROM ${BASE_REGISTRY}/library/node:22-alpine
ARG npm_config_registry
ENV NODE_ENV=production PORT=3000 STATIC_DIR=/app/public LIBRARIES_DIR=/app/libraries DATA_DIR=/data
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/src ./src
COPY --from=app /src/upstream/excalidraw-app/build /app/public
COPY --from=libs /out/libraries /app/libraries
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1
CMD ["node", "src/server.js"]
