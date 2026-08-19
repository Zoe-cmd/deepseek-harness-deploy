# Auth gateway image — zero runtime dependencies (node:http + node:crypto only).
FROM node:22-alpine

WORKDIR /app

# Gateway sources only; the Harness itself runs natively (loopback).
COPY package.json server.mjs config.mjs session.mjs auth.mjs proxy.mjs views.mjs ./

ENV NODE_ENV=production
USER node
EXPOSE 3081

HEALTHCHECK --interval=10s --timeout=3s --start-period=3s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3081/healthz || exit 1

ENTRYPOINT ["node", "server.mjs"]