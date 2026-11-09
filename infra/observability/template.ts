/** Prepared monitoring stack; function/stage owners must attach the exported settings. No deployment. */
type Json = Record<string, unknown>;
const ref = (name: string) => ({ Ref: name });
const sub = (value: string) => ({ 'Fn::Sub': value });
const componentNames = ['Access', 'Authorizer', 'Billing'] as const;
const metric = (namespace: string, name: string, dimensions: Record<string, unknown>, stat = 'Sum') => ({
  Metric: { Namespace: namespace, MetricName: name, Dimensions: Object.entries(dimensions).map(([Name, Value]) => ({ Name, Value })) },
  Period: ref('MetricPeriodSeconds'), Stat: stat,
});
export function observabilityTemplate(): Json {
  const parameters: Json = {
    Environment: { Type: 'String', Default: 'development', AllowedValues: ['development','test','production'] },
    Tracing: { Type: 'String', Default: 'auto', AllowedValues: ['auto','enabled','disabled'] },
    EnableAlarms: { Type: 'String', Default: 'false', AllowedValues: ['false','true'] },
    SamplingPriority: { Type: 'Number', MinValue: 1, MaxValue: 9999 },
    MetricPeriodSeconds: { Type: 'Number', Default: 60, AllowedValues: [60,300,900] },
    EvaluationPeriods: { Type: 'Number', MinValue: 1, MaxValue: 60 },
    MissingDataPolicy: { Type: 'String', AllowedValues: ['breaching','notBreaching','ignore','missing'] },
    NotificationTopicArn: { Type: 'String', AllowedPattern: '^arn:aws:sns:[a-z0-9-]+:[0-9]{12}:[A-Za-z0-9_-]+$' },
    RestApiId: { Type: 'String', AllowedPattern: '^[a-z0-9]+$' },
    RestApiName: { Type: 'String', AllowedPattern: '^[A-Za-z0-9_. -]{1,128}$' },
    StageName: { Type: 'String', AllowedPattern: '^[A-Za-z0-9_-]{1,128}$' },
  };
  for (const name of ['AccessFunctionName','AuthorizerFunctionName','BillingFunctionName','BillingQueueName','BillingDlqName','BillingPipeName',
    'AccessTableName','BillingTableName','EntitlementTableName']) parameters[name] = { Type: 'String', AllowedPattern: '^[A-Za-z0-9_.-]{1,128}$' };
  for (const name of ['ErrorThreshold','QueueAgeThreshold','DueAgeThreshold','PipeFailureThreshold','ThrottleThreshold']) parameters[name] = { Type: 'Number', MinValue: 1 };
  const conditions = {
    Production: { 'Fn::Equals': [ref('Environment'), 'production'] },
    TracingEnabled: { 'Fn::Or': [{ 'Fn::Equals': [ref('Tracing'), 'enabled'] }, { 'Fn::And': [
      { Condition: 'Production' }, { 'Fn::Equals': [ref('Tracing'), 'auto'] },
    ] }] },
    AlarmsEnabled: { 'Fn::Equals': [ref('EnableAlarms'), 'true'] },
  };
  const resources: Json = {};
  for (const component of [...componentNames, 'Gateway'] as const) {
    const name = component === 'Gateway' ? sub('/aws/apigateway/${RestApiId}/${StageName}/access') : sub(`/aws/lambda/\${${component}FunctionName}`);
    resources[`${component}LogGroup`] = { Type: 'AWS::Logs::LogGroup', DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain', Properties: {
      LogGroupName: name, RetentionInDays: { 'Fn::If': ['Production', 14, 3] },
      Tags: [{ Key: 'Project', Value: 'mcp-auth-subscriptions' }, { Key: 'Environment', Value: ref('Environment') }],
    } };
    resources[`${component}TelemetryPolicy`] = { Type: 'AWS::IAM::ManagedPolicy', Properties: {
      Description: `Attach to the existing ${component.toLowerCase()} role; no business-data rights`,
      PolicyDocument: { Version: '2012-10-17', Statement: [
        { Effect: 'Allow', Action: ['logs:CreateLogStream','logs:PutLogEvents'], Resource: component === 'Gateway' ?
          sub('arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/apigateway/${RestApiId}/${StageName}/access:log-stream:*') :
          sub(`arn:\${AWS::Partition}:logs:\${AWS::Region}:\${AWS::AccountId}:log-group:/aws/lambda/\${${component}FunctionName}:log-stream:*`) },
        ...(component === 'Gateway' ? [] : [{ 'Fn::If': ['TracingEnabled', {
          Effect: 'Allow', Action: ['xray:PutTraceSegments','xray:PutTelemetryRecords'], Resource: '*',
        }, ref('AWS::NoValue')] }]),
      ] },
    } };
  }
  resources.GatewayExecutionLogGroup = { Type: 'AWS::Logs::LogGroup', DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain', Properties: {
    LogGroupName: sub('API-Gateway-Execution-Logs_${RestApiId}/${StageName}'),
    Tags: [{ Key: 'Project', Value: 'mcp-auth-subscriptions' }, { Key: 'Environment', Value: ref('Environment') }],
    RetentionInDays: { 'Fn::If': ['Production', 14, 3] },
  } };
  const gatewayPolicy = resources.GatewayTelemetryPolicy as { Properties: { PolicyDocument: { Statement: Json[] } } };
  gatewayPolicy.Properties.PolicyDocument.Statement[0]!.Resource = [
    sub('arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/apigateway/${RestApiId}/${StageName}/access:log-stream:*'),
    sub('arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:API-Gateway-Execution-Logs_${RestApiId}/${StageName}:log-stream:*'),
  ];
  gatewayPolicy.Properties.PolicyDocument.Statement.push({ Effect: 'Allow', Action: ['logs:DescribeLogStreams'], Resource: [
    sub('arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/apigateway/${RestApiId}/${StageName}/access'),
    sub('arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:API-Gateway-Execution-Logs_${RestApiId}/${StageName}'),
  ] }, { Effect: 'Allow', Action: ['logs:DescribeLogGroups'], Resource: '*' });
  resources.GatewaySampling = { Type: 'AWS::XRay::SamplingRule', Condition: 'TracingEnabled', Properties: { SamplingRule: {
    Version: 1, Priority: ref('SamplingPriority'), ReservoirSize: 0, FixedRate: .01,
    Host: '*', HTTPMethod: '*', URLPath: '*', ServiceName: '*', ServiceType: 'AWS::ApiGateway::Stage',
    ResourceARN: sub('arn:${AWS::Partition}:apigateway:${AWS::Region}::/restapis/${RestApiId}/stages/${StageName}'),
  } } };
  const alarmBase = { EvaluationPeriods: ref('EvaluationPeriods'), ComparisonOperator: 'GreaterThanOrEqualToThreshold',
    TreatMissingData: ref('MissingDataPolicy'), AlarmActions: [ref('NotificationTopicArn')] };
  function alarm(name: string, metrics: unknown[], threshold: string) {
    resources[name] = { Type: 'AWS::CloudWatch::Alarm', Condition: 'AlarmsEnabled', Properties: { ...alarmBase, Metrics: metrics, Threshold: ref(threshold) } };
  }
  for (const component of componentNames) alarm(`${component}Errors`, [{ Id: 'errors', ReturnData: true,
    MetricStat: metric('AWS/Lambda', 'Errors', { FunctionName: ref(`${component}FunctionName`) }) }], 'ErrorThreshold');
  alarm('GatewayErrors', [{ Id: 'errors', ReturnData: true, MetricStat: metric('AWS/ApiGateway', '5XXError', { ApiName: ref('RestApiName'), Stage: ref('StageName') }) }], 'ErrorThreshold');
  alarm('BillingDlq', [{ Id: 'visible', ReturnData: true, MetricStat: metric('AWS/SQS','ApproximateNumberOfMessagesVisible', { QueueName: ref('BillingDlqName') }, 'Maximum') }], 'ErrorThreshold');
  alarm('BillingQueueAge', [{ Id: 'age', ReturnData: true, MetricStat: metric('AWS/SQS','ApproximateAgeOfOldestMessage', { QueueName: ref('BillingQueueName') }, 'Maximum') }], 'QueueAgeThreshold');
  alarm('BillingDurableDueAge', [{ Id: 'age', ReturnData: true, MetricStat: metric('MCP/Operations','BillingReconcileDueAgeSeconds', { service: 'billing', environment: ref('Environment') }, 'Maximum') }], 'DueAgeThreshold');
  alarm('BillingPipeFailures', [{ Id: 'failures', ReturnData: true, MetricStat: metric('AWS/Pipes','ExecutionFailed', { PipeName: ref('BillingPipeName') }) }], 'PipeFailureThreshold');
  alarm('AggregateLambdaThrottles', [
    ...componentNames.map((component, index) => ({ Id: `m${index}`, ReturnData: false, MetricStat: metric('AWS/Lambda','Throttles',{ FunctionName: ref(`${component}FunctionName`) }) })),
    { Id: 'total', ReturnData: true, Expression: 'SUM(METRICS())' },
  ], 'ThrottleThreshold');
  alarm('DynamoThrottles', [
    ...['AccessTableName','BillingTableName','EntitlementTableName'].flatMap((table, index) => ['ReadThrottleEvents','WriteThrottleEvents'].map((name, i) => ({
      Id: `m${index}${i}`, ReturnData: false, MetricStat: metric('AWS/DynamoDB',name,{ TableName: ref(table) }),
    }))),
    { Id: 'total', ReturnData: true, Expression: 'SUM(METRICS())' },
  ], 'ThrottleThreshold');
  resources.Dashboard = { Type: 'AWS::CloudWatch::Dashboard', Condition: 'Production', Properties: { DashboardBody: sub(JSON.stringify({ widgets: [
    { type: 'metric', width: 12, height: 6, properties: { title: 'Lambda errors', region: '${AWS::Region}', view: 'timeSeries', stat: 'Sum', period: 60,
      metrics: componentNames.map(component => ['AWS/Lambda','Errors','FunctionName', `\${${component}FunctionName}`]) } },
    { type: 'metric', width: 12, height: 6, properties: { title: 'Lambda duration', region: '${AWS::Region}', view: 'timeSeries', stat: 'p95', period: 60,
      metrics: componentNames.map(component => ['AWS/Lambda','Duration','FunctionName', `\${${component}FunctionName}`]) } },
    { type: 'metric', width: 12, height: 6, properties: { title: 'Billing backlog', region: '${AWS::Region}', view: 'timeSeries', stat: 'Maximum', period: 60,
      metrics: [['AWS/SQS','ApproximateAgeOfOldestMessage','QueueName','${BillingQueueName}'], ['MCP/Operations','BillingReconcileDueAgeSeconds','service','billing','environment','${Environment}']] } },
  ] })) } };
  const outputs: Json = {};
  for (const component of [...componentNames, 'Gateway']) {
    outputs[`${component}LogGroupArn`] = { Value: { 'Fn::GetAtt': [`${component}LogGroup`, 'Arn'] } };
    outputs[`${component}TelemetryPolicyArn`] = { Value: ref(`${component}TelemetryPolicy`) };
  }
  outputs.GatewayExecutionLogGroupArn = { Value: { 'Fn::GetAtt': ['GatewayExecutionLogGroup', 'Arn'] } };
  outputs.LambdaTracingMode = { Value: { 'Fn::If': ['TracingEnabled', 'Active', 'PassThrough'] } };
  outputs.GatewayAccessFormat = { Value: JSON.stringify({ request_id: '$context.requestId', extended_request_id: '$context.extendedRequestId',
    operation: '$context.httpMethod $context.resourcePath', status: '$context.status', latency_ms: '$context.responseLatency',
    integration_latency_ms: '$context.integrationLatency' }) };
  return { AWSTemplateFormatVersion: '2010-09-09', Description: 'Prepared access/billing monitoring; attach outputs in component-owned runtime/stage stacks',
    Parameters: parameters, Conditions: conditions, Resources: resources, Outputs: outputs };
}
/** Merge only in the gateway-owned stack; does not create/update a shared REST stage. */
export function gatewayStageSettings(logGroupArn: unknown, format: unknown, tracing: unknown) {
  return { TracingEnabled: tracing, AccessLogSetting: { DestinationArn: logGroupArn, Format: format },
    MethodSettings: [{ ResourcePath: '/*', HttpMethod: '*', DataTraceEnabled: false, LoggingLevel: 'ERROR', MetricsEnabled: false }] };
}
export function lambdaTelemetrySettings(tracingMode: unknown, service: string, environment: unknown, release: unknown) {
  if (!['access','authorizer','billing'].includes(service)) throw new Error('invalid_observability_service');
  return { TracingConfig: { Mode: tracingMode }, Environment: { Variables: {
    MCP_SERVICE: service, MCP_ENVIRONMENT: environment, MCP_RELEASE: release,
  } } };
}
