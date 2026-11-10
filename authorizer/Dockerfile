# syntax=docker/dockerfile:1
ARG BUILD_IMAGE=node:24-bookworm-slim
ARG LAMBDA_IMAGE=public.ecr.aws/lambda/nodejs:24
FROM ${BUILD_IMAGE} AS build
WORKDIR /build
COPY package.json package-lock.json tsconfig.json ./
COPY Dockerfile.billing ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca npm ci; else npm ci; fi
COPY billing ./billing
COPY access ./access
COPY authorizer ./authorizer
COPY security ./security
COPY observability ./observability
COPY infra ./infra
COPY tests ./tests
COPY specs ./specs
RUN npm run check
FROM ${BUILD_IMAGE} AS dependencies
WORKDIR /app
COPY authorizer/package.json authorizer/package-lock.json ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca npm ci --omit=dev; else npm ci --omit=dev; fi
FROM dependencies AS validation
COPY --from=build /build/dist/authorizer ./dist/authorizer
COPY --from=build /build/dist/security ./dist/security
COPY --from=build /build/dist/observability ./dist/observability
COPY authorizer/smoke.mjs ./smoke.mjs
RUN node smoke.mjs
FROM ${LAMBDA_IMAGE}
COPY --from=dependencies /app/package.json ${LAMBDA_TASK_ROOT}/package.json
COPY --from=dependencies /app/node_modules ${LAMBDA_TASK_ROOT}/node_modules
COPY --from=build /build/dist/authorizer ${LAMBDA_TASK_ROOT}/dist/authorizer
COPY --from=build /build/dist/security ${LAMBDA_TASK_ROOT}/dist/security
COPY --from=build /build/dist/observability ${LAMBDA_TASK_ROOT}/dist/observability
CMD ["dist/authorizer/handler.handler"]
