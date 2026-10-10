FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS build

WORKDIR /app
RUN corepack enable && chown node:node /app
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=node:node frontend/web/package.json ./frontend/web/package.json
COPY --chown=node:node frontend/packages/shared/package.json ./frontend/packages/shared/package.json
COPY --chown=node:node frontend/mobile/package.json ./frontend/mobile/package.json
USER node
RUN pnpm --filter govbiz-web... install --frozen-lockfile --network-concurrency=8
COPY --chown=node:node frontend/web ./frontend/web
COPY --chown=node:node frontend/packages/shared ./frontend/packages/shared

# Both modes ignore .env files and inherited VITE_*; development login stays off.
# connected enables the AI UI, not automatic evaluation/model calls.
ARG WEB_MODE=portfolio
RUN case "$WEB_MODE" in portfolio|connected) ;; *) exit 1 ;; esac \
    && pnpm --filter govbiz-web exec tsc -b \
    && pnpm --filter govbiz-web exec vite build --mode "$WEB_MODE"

FROM nginx:1.30.4-alpine@sha256:dc5069ad14f19660b141b21236140b91656bf89bbc3e2417c70ae650cd66104c
COPY frontend/web/nginx.conf /etc/nginx/govbiz.conf
COPY --from=build /app/frontend/web/dist/ /usr/share/nginx/html/
USER 101:101
EXPOSE 8080
# No entrypoint templating, writable /etc, Node.js or development server at runtime.
ENTRYPOINT ["nginx", "-c", "/etc/nginx/govbiz.conf"]
CMD ["-g", "daemon off;"]
