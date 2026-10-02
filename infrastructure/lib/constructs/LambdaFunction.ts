import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface LambdaFunctionProps {
  /**
   * The domain/service name used for naming and tagging (e.g., "auth", "events", "tickets").
   */
  readonly functionName: string;

  /**
   * Path to the Lambda handler code (asset directory or bundled zip).
   * Passed directly to `lambda.Code.fromAsset()`.
   */
  readonly codePath: string;

  /**
   * Handler method in the form `file.exportedFunction` (e.g., "handler.handler").
   * Defaults to "handler.handler".
   */
  readonly handler?: string;

  /**
   * Memory size in MB. Defaults to 256.
   */
  readonly memorySize?: number;

  /**
   * Timeout for the function. Defaults to 30 seconds.
   */
  readonly timeout?: cdk.Duration;

  /**
   * Environment variables injected into the Lambda runtime.
   */
  readonly environment?: Record<string, string>;

  /**
   * Layers to attach to the function.
   */
  readonly layers?: lambda.ILayerVersion[];

  /**
   * Log retention period. Defaults to 90 days.
   */
  readonly logRetention?: logs.RetentionDays;
}

/**
 * LambdaFunction construct
 *
 * Opinionated wrapper around `lambda.Function` that enforces:
 *  - Node.js 20 runtime
 *  - TypeScript strict mode (compiled before deploy)
 *  - Structured CloudWatch log group with configurable retention
 *  - X-Ray active tracing
 *  - ARM64 architecture (Graviton2 — cost/perf)
 *  - Standard naming convention: `clois-{functionName}`
 */
export class LambdaFunction extends Construct {
  public readonly fn: lambda.Function;
  public readonly logGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: LambdaFunctionProps) {
    super(scope, id);

    const {
      functionName,
      codePath,
      handler = 'handler.handler',
      memorySize = 256,
      timeout = cdk.Duration.seconds(30),
      environment = {},
      layers = [],
      logRetention = logs.RetentionDays.THREE_MONTHS,
    } = props;

    const cfnFunctionName = `clois-${functionName}`;

    this.logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `/aws/lambda/${cfnFunctionName}`,
      retention: logRetention,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.fn = new lambda.Function(this, 'Function', {
      functionName: cfnFunctionName,
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      handler,
      code: lambda.Code.fromAsset(codePath),
      memorySize,
      timeout,
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        ...environment,
      },
      tracing: lambda.Tracing.ACTIVE,
      logGroup: this.logGroup,
      layers,
    });
  }
}
