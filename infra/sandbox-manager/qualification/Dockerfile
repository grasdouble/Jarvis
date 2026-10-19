FROM node:24.22.0-bookworm-slim@sha256:156e9bc7a0a267cc6ca77b4283e32b123479342df684ce297455d7b95ff5a6b5

COPY qualification-probe.mjs /opt/jarvis/qualification-probe.mjs
COPY jarvis-sandbox /usr/local/bin/jarvis-sandbox
RUN chmod 0555 /usr/local/bin/jarvis-sandbox
USER 10001:10001
WORKDIR /workspace
ENTRYPOINT ["node", "/opt/jarvis/qualification-probe.mjs"]
