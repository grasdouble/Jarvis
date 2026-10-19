FROM node:24.22.0-bookworm-slim@sha256:156e9bc7a0a267cc6ca77b4283e32b123479342df684ce297455d7b95ff5a6b5

ADD --checksum=sha256:c2e4f6c94f2e58a2df99cc647bd37285569600d7435e3796152825d8c9d10382 \
  https://opencode.ai/files/bin/2.0.32/opencode-linux-arm64.tar.gz /tmp/opencode.tar.gz

RUN tar -xzf /tmp/opencode.tar.gz -C /usr/local/bin opencode \
  && rm /tmp/opencode.tar.gz \
  && chmod 0555 /usr/local/bin/opencode \
  && opencode --version

ENV HOME=/state/home \
    XDG_CONFIG_HOME=/config \
    XDG_DATA_HOME=/state/data \
    XDG_CACHE_HOME=/state/cache \
    XDG_STATE_HOME=/state/state

LABEL org.opencontainers.image.version="2.0.32"

COPY apps/llm-gateway/dist/gateway.js /opt/jarvis/gateway.js
COPY packages/runtime/dist/index.js /opt/jarvis/runtime-client.mjs
COPY infra/opencode-prototype/opencode-entrypoint.mjs /opt/jarvis/opencode-entrypoint.mjs
COPY infra/opencode-prototype/api-probe.mjs /opt/jarvis/api-probe.mjs

USER 10001:10001
WORKDIR /workspace
ENTRYPOINT ["node", "/opt/jarvis/opencode-entrypoint.mjs"]
