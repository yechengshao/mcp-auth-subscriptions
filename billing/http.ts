import { AsyncLocalStorage } from 'node:async_hooks';
import express, { type ErrorRequestHandler } from 'express';
import { configure as serverlessExpress } from '@codegenie/serverless-express';
import type { HttpEvent, HttpResult, InvocationContext } from '../observability/adapters.js';
/** Express sees exact raw bytes; native/SQS/schedule events never enter this adapter. */
export function createBillingHttpAdapter(webhook: (event: HttpEvent & Record<string, any>, context: InvocationContext) => Promise<HttpResult>) {
  const invocation = new AsyncLocalStorage<{ event: HttpEvent & Record<string, any>; context: InvocationContext }>();
  const app = express(); app.disable('x-powered-by');
  app.post('/billing/webhook', express.raw({ type: () => true, limit: '1mb', inflate: false }), async (request, response) => {
    const current = invocation.getStore();
    if (!current || !Buffer.isBuffer(request.body)) { response.status(400).end(); return; }
    const result = await webhook({ ...current.event, body: request.body.toString('base64'), isBase64Encoded: true }, current.context);
    response.status(result.statusCode);
    for (const [key, value] of Object.entries(result.headers ?? {})) response.setHeader(key, value);
    response.end(result.body ?? '');
  });
  app.use((_request, response) => { response.status(404).end(); });
  const errorHandler: ErrorRequestHandler = (_error, _request, response, _next) => { response.status(400).end(); };
  app.use(errorHandler);
  // The transport's own verbose/error logger can contain request bodies. Our wrapper owns safe logs.
  const proxy = serverlessExpress({ app, eventSourceName: 'AWS_API_GATEWAY_V1', respondWithErrors: false, logSettings: { level: 'none' } });
  return { app, invoke: (event: HttpEvent & Record<string, any>, context: InvocationContext) =>
    invocation.run({ event, context }, () => proxy(event, context as any, () => undefined)) };
}
