ARG NODE_BUILD_IMAGE
ARG LAMBDA_RUNTIME_IMAGE
FROM ${NODE_BUILD_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build \
  && rm -rf dist/tests dist/authorizer dist/infra dist/scripts \
  && find dist/billing -mindepth 1 -maxdepth 1 ! -name contracts -exec rm -rf {} + \
  && npm prune --omit=dev

FROM ${LAMBDA_RUNTIME_IMAGE}
WORKDIR ${LAMBDA_TASK_ROOT}
COPY --from=build /app/dist/access ./dist/access
COPY --from=build /app/dist/billing/contracts ./dist/billing/contracts
COPY --from=build /app/dist/contracts ./dist/contracts
COPY --from=build /app/dist/security ./dist/security
COPY --from=build /app/dist/observability ./dist/observability
COPY --from=build /app/node_modules ./node_modules
CMD ["dist/access/handler.handler"]
