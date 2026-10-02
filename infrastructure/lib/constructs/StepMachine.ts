import * as cdk from 'aws-cdk-lib';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface StepMachineProps {
  /**
   * Logical name for the state machine (e.g., "event-publish", "cancellation").
   * Becomes `clois-{name}-workflow`.
   */
  readonly machineName: string;

  /**
   * The root state of the state machine definition.
   */
  readonly definition: sfn.IChainable;

  /**
   * Log retention period. Defaults to 90 days.
   */
  readonly logRetention?: logs.RetentionDays;

  /**
   * Type of state machine. Defaults to STANDARD for durability.
   */
  readonly stateMachineType?: sfn.StateMachineType;
}

/**
 * Standard retry configuration used by every Step Functions task state in CLOIS.
 *
 * Per design requirements (Req 11.6 / backend-conventions):
 *  - IntervalSeconds: 5
 *  - MaxAttempts:     3
 *  - BackoffRate:     2.0
 */
export const STANDARD_RETRY: sfn.RetryProps = {
  errors: [
    'States.TaskFailed',
    'Lambda.ServiceException',
    'Lambda.AWSLambdaException',
    'Lambda.SdkClientException',
    'Lambda.TooManyRequestsException',
  ],
  interval: cdk.Duration.seconds(5),
  maxAttempts: 3,
  backoffRate: 2.0,
};

/**
 * StepMachine construct
 *
 * Opinionated wrapper around `sfn.StateMachine` that enforces:
 *  - STANDARD execution type (for durability + audit trail)
 *  - CloudWatch log group with configurable retention
 *  - X-Ray tracing enabled
 *  - Standard naming: `clois-{machineName}-workflow`
 *
 * Every Task state should apply `STANDARD_RETRY` via `.addRetry(STANDARD_RETRY)`
 * and a catch state via `.addCatch(markWorkflowFailed)`.
 */
export class StepMachine extends Construct {
  public readonly stateMachine: sfn.StateMachine;
  public readonly logGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: StepMachineProps) {
    super(scope, id);

    const {
      machineName,
      definition,
      logRetention = logs.RetentionDays.THREE_MONTHS,
      stateMachineType = sfn.StateMachineType.STANDARD,
    } = props;

    const cfnName = `clois-${machineName}-workflow`;

    this.logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `/aws/states/${cfnName}`,
      retention: logRetention,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.stateMachine = new sfn.StateMachine(this, 'StateMachine', {
      stateMachineName: cfnName,
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      stateMachineType,
      tracingEnabled: true,
      logs: {
        destination: this.logGroup,
        level: sfn.LogLevel.ALL,
        includeExecutionData: true,
      },
    });
  }
}
