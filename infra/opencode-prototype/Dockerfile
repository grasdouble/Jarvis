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

COPY packages/llm/package.json /opt/jarvis/node_modules/@jarvis/llm/package.json
COPY packages/llm/dist/ /opt/jarvis/node_modules/@jarvis/llm/dist/
COPY apps/llm-gateway/dist/gateway.js /opt/jarvis/gateway.js
COPY packages/runtime/dist/opencode-client.js /opt/jarvis/runtime-client.mjs
COPY packages/runtime/dist/advisory-results.js /opt/jarvis/advisory-results.mjs
COPY packages/runtime/dist/advisory-results.js /opt/jarvis/advisory-results.js
COPY infra/opencode-prototype/opencode-entrypoint.mjs /opt/jarvis/opencode-entrypoint.mjs
COPY infra/opencode-prototype/api-probe.mjs /opt/jarvis/api-probe.mjs
COPY infra/opencode-prototype/fixed-relay.mjs /usr/local/bin/jarvis-opencode-relay
COPY infra/opencode-prototype/opencode-usage-plugin.mjs /opt/jarvis/opencode-usage-plugin/opencode-usage-plugin.mjs
COPY infra/opencode-prototype/usage-plugin-package.json /opt/jarvis/opencode-usage-plugin/package.json
RUN chmod 0555 /opt/jarvis/opencode-usage-plugin/opencode-usage-plugin.mjs /opt/jarvis/opencode-usage-plugin/package.json
RUN chmod 0555 /usr/local/bin/jarvis-opencode-relay

USER 10001:10001
WORKDIR /workspace
ENTRYPOINT ["node", "/opt/jarvis/opencode-entrypoint.mjs"]
