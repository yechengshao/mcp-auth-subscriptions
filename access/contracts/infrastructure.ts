/** Exact cross-stack grants; billing/provider authority never comes from browser JSON. */
export function accessDependencyGrants(entitlementArn: string, billingAlias: string) {
  const table = /^arn:aws:dynamodb:([a-z0-9-]+):([0-9]{12}):table\/[A-Za-z0-9_.-]+$/.exec(entitlementArn);
  const alias = /^arn:aws:lambda:([a-z0-9-]+):([0-9]{12}):function:[A-Za-z0-9_-]+:([A-Za-z][A-Za-z0-9_-]*)$/.exec(billingAlias);
  if (!table || !alias || table[1] !== alias[1] || table[2] !== alias[2]) throw new Error('invalid_access_dependencies');
  return [{ Effect: 'Allow', Action: ['dynamodb:GetItem', 'dynamodb:ConditionCheckItem'], Resource: entitlementArn },
    { Effect: 'Allow', Action: ['lambda:InvokeFunction'], Resource: billingAlias }];
}
export function authorizerLogPolicy(logGroupArn: string, tracing: boolean) {
  if (!/^arn:aws:logs:[a-z0-9-]+:[0-9]{12}:log-group:\/aws\/lambda\/[A-Za-z0-9_-]+$/.test(logGroupArn)) throw new Error('invalid_authorizer_log_group');
  return [{ Effect: 'Allow', Action: ['logs:CreateLogStream', 'logs:PutLogEvents'], Resource: `${logGroupArn}:log-stream:*` },
    ...(tracing ? [{ Effect: 'Allow', Action: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'], Resource: '*' }] : [])];
}
