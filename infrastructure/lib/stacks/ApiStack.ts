import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface ApiStackProps extends cdk.StackProps {
  authFunctionArn?: string;
}

/**
 * APIStack
 *
 * Provisions the REST API Gateway for CLOIS:
 * - /v1/* prefix for all endpoints
 * - Lambda Token Authorizer (AuthorizerFn) attached
 * - X-Correlation-ID context variable propagation
 * - Access logging to CloudWatch
 * Requirements: 23.1, 23.5, 23.6
 */
export class ApiStack extends cdk.Stack {
  public readonly api: apigateway.RestApi;
  public readonly authorizer: apigateway.TokenAuthorizer | undefined;

  constructor(scope: Construct, id: string, props?: ApiStackProps) {
    super(scope, id, props);

    // Access log group
    const accessLogGroup = new logs.LogGroup(this, 'ApiAccessLogs', {
      logGroupName: '/aws/apigateway/clois-api',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // REST API
    this.api = new apigateway.RestApi(this, 'CloisApi', {
      restApiName: 'clois-api',
      description: 'CLOIS REST API v1',
      deployOptions: {
        stageName: 'prod',
        accessLogDestination: new apigateway.LogGroupLogDestination(accessLogGroup),
        accessLogFormat: apigateway.AccessLogFormat.custom(
          JSON.stringify({
            requestId: '.requestId',
            correlationId: '.authorizer.correlationId',
            ip: '.identity.sourceIp',
            method: '.httpMethod',
            path: '.path',
            status: '.status',
            responseLength: '.responseLength',
            responseTime: '.responseLatency',
          }),
        ),
        tracingEnabled: true,
        metricsEnabled: true,
        loggingLevel: apigateway.MethodLoggingLevel.ERROR,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: [
          'Content-Type',
          'Authorization',
          'X-Correlation-ID',
          'X-Amz-Date',
          'X-Api-Key',
          'X-Amz-Security-Token',
        ],
      },
    });

    // Lambda Authorizer (wired when authFunctionArn is provided)
    if (props?.authFunctionArn) {
      const authFn = lambda.Function.fromFunctionArn(this, 'AuthorizerFn', props.authFunctionArn);
      this.authorizer = new apigateway.TokenAuthorizer(this, 'CloisAuthorizer', {
        handler: authFn,
        authorizerName: 'CloisTokenAuthorizer',
        identitySource: 'method.request.header.Authorization',
        resultsCacheTtl: cdk.Duration.minutes(5),
      });
    }

    // /v1 base resource
    const v1 = this.api.root.addResource('v1');

    // /v1/auth/* — public endpoints (no authorizer)
    const auth = v1.addResource('auth');
    const authRoutes = [
      'register',
      'verify-email',
      'login',
      'refresh',
      'forgot-password',
      'reset-password',
    ];
    for (const route of authRoutes) {
      auth.addResource(route).addMethod('POST', new apigateway.HttpIntegration('http://placeholder'), {
        methodResponses: [
          { statusCode: '200' },
          { statusCode: '201' },
          { statusCode: '400' },
          { statusCode: '401' },
          { statusCode: '409' },
          { statusCode: '500' },
        ],
      });
    }

    // /v1/auth/mfa/enable, /v1/auth/mfa/disable, /v1/auth/mfa/verify
    const mfa = auth.addResource('mfa');
    for (const route of ['enable', 'disable', 'verify']) {
      mfa.addResource(route).addMethod('PUT', new apigateway.HttpIntegration('http://placeholder'));
    }

    // Gateway responses for 401 and 403 with standard error format
    this.api.addGatewayResponse('UnauthorizedResponse', {
      type: apigateway.ResponseType.UNAUTHORIZED,
      statusCode: '401',
      responseHeaders: { 'Content-Type': "'application/json'" },
      templates: {
        'application/json': JSON.stringify({
          errorCode: 'auth.unauthorized',
          message: 'Missing or invalid authentication token.',
          correlationId: '.requestId',
        }),
      },
    });

    this.api.addGatewayResponse('AccessDeniedResponse', {
      type: apigateway.ResponseType.ACCESS_DENIED,
      statusCode: '403',
      responseHeaders: { 'Content-Type': "'application/json'" },
      templates: {
        'application/json': JSON.stringify({
          errorCode: 'auth.access_denied',
          message: 'You do not have permission to access this resource.',
          correlationId: '.requestId',
        }),
      },
    });

    // Outputs
    new cdk.CfnOutput(this, 'ApiUrl', { value: this.api.url });
    new cdk.CfnOutput(this, 'ApiId', { value: this.api.restApiId });
  }

  /**
   * Wire a Lambda function to an API path+method with the authorizer attached.
   * Called by domain stacks to add their routes.
   */
  public addRoute(
    path: string,
    method: string,
    lambdaFn: lambda.IFunction,
    requiresAuth = true,
  ): apigateway.Method {
    const segments = path.replace(/^\/v1\//, '').split('/');
    let resource: apigateway.IResource = this.api.root.getResource('v1') ?? this.api.root.addResource('v1');

    for (const segment of segments) {
      resource = resource.getResource(segment) ?? resource.addResource(segment);
    }

    return resource.addMethod(
      method,
      new apigateway.LambdaIntegration(lambdaFn, {
        proxy: true,
        passthroughBehavior: apigateway.PassthroughBehavior.WHEN_NO_MATCH,
        requestParameters: {
          'integration.request.header.X-Correlation-ID': 'context.requestId',
        },
      }),
      {
        authorizer: requiresAuth && this.authorizer ? this.authorizer : undefined,
        authorizationType: requiresAuth && this.authorizer
          ? apigateway.AuthorizationType.CUSTOM
          : apigateway.AuthorizationType.NONE,
        methodResponses: [
          { statusCode: '200' },
          { statusCode: '201' },
          { statusCode: '204' },
          { statusCode: '400' },
          { statusCode: '401' },
          { statusCode: '403' },
          { statusCode: '404' },
          { statusCode: '409' },
          { statusCode: '500' },
        ],
      },
    );
  }
}