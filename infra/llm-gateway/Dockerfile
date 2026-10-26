ARG NODE_BASE_IMAGE
FROM ${NODE_BASE_IMAGE} AS build
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/llm-gateway/package.json apps/llm-gateway/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/llm/package.json packages/llm/package.json
RUN pnpm install --frozen-lockfile
COPY apps/llm-gateway apps/llm-gateway
COPY packages/contracts packages/contracts
COPY packages/llm packages/llm
RUN pnpm --filter @jarvis/llm-gateway build

FROM ${NODE_BASE_IMAGE}
WORKDIR /opt/jarvis
COPY --from=build --chown=10001:10001 /workspace/apps/llm-gateway/dist ./dist
USER 10001:10001
ENTRYPOINT ["node", "/opt/jarvis/dist/main.js"]
