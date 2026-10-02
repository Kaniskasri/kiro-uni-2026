import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

/**
 * DatabaseStack
 *
 * Provisions all DynamoDB tables for CLOIS:
 *  - clois-main          : single-table design (PK/SK + 4 GSIs)
 *  - clois-audit-log     : append-only audit table (resource policy blocks DeleteItem/UpdateItem)
 *  - clois-ws-connections: WebSocket connection tracking with TTL
 */
export class DatabaseStack extends cdk.Stack {
  /** Main single-table for all domain entities */
  public readonly mainTable: dynamodb.Table;
  /** Immutable audit log table */
  public readonly auditLogTable: dynamodb.Table;
  /** WebSocket connection table */
  public readonly wsConnectionsTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ─── clois-main ──────────────────────────────────────────────────────────
    this.mainTable = new dynamodb.Table(this, 'MainTable', {
      tableName: 'clois-main',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // GSI1: multi-purpose secondary lookups (slug uniqueness, token lookups, ticket-by-code)
    this.mainTable.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI2: event status + org queries (list events by org+status, sorted by start time)
    this.mainTable.addGlobalSecondaryIndex({
      indexName: 'GSI2',
      partitionKey: { name: 'GSI2PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI2SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI3: ticket lookups by member/guest email (duplicate RSVP checks)
    this.mainTable.addGlobalSecondaryIndex({
      indexName: 'GSI3',
      partitionKey: { name: 'GSI3PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI3SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI4: notification delivery queries
    this.mainTable.addGlobalSecondaryIndex({
      indexName: 'GSI4',
      partitionKey: { name: 'GSI4PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI4SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ─── clois-audit-log ─────────────────────────────────────────────────────
    // Append-only: application roles must never have DeleteItem or UpdateItem.
    // The resource policy here is advisory; enforcement is via IAM (no Lambda role
    // is granted those actions). A DenyAll resource-based policy is added for defence-in-depth.
    this.auditLogTable = new dynamodb.Table(this, 'AuditLogTable', {
      tableName: 'clois-audit-log',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // GSI1 on audit log: filter by actor
    this.auditLogTable.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI2 on audit log: filter by operation type
    this.auditLogTable.addGlobalSecondaryIndex({
      indexName: 'GSI2',
      partitionKey: { name: 'GSI2PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI2SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Resource-based policy: deny DeleteItem and UpdateItem for all principals except
    // the CDK deployment role. This is defence-in-depth on top of IAM least-privilege.
    // AWS::DynamoDB::ResourcePolicy is provisioned as a raw CfnResource because
    // CfnResourcePolicy is not available in aws-cdk-lib 2.144.0.
    new cdk.CfnResource(this, 'AuditLogResourcePolicy', {
      type: 'AWS::DynamoDB::ResourcePolicy',
      properties: {
        ResourceArn: this.auditLogTable.tableArn,
        PolicyDocument: {
          Version: '2012-10-17',
          Statement: [
            {
              Sid: 'DenyMutationOnAuditLog',
              Effect: 'Deny',
              Principal: { AWS: '*' },
              Action: ['dynamodb:DeleteItem', 'dynamodb:UpdateItem'],
              Resource: this.auditLogTable.tableArn,
              Condition: {
                StringNotLike: {
                  'aws:PrincipalArn': [
                    `arn:aws:iam::${this.account}:role/cdk-*`,
                    `arn:aws:iam::${this.account}:role/aws-service-role/*`,
                  ],
                },
              },
            },
          ],
        },
      },
    });

    // ─── clois-ws-connections ─────────────────────────────────────────────────
    this.wsConnectionsTable = new dynamodb.Table(this, 'WsConnectionsTable', {
      tableName: 'clois-ws-connections',
      partitionKey: { name: 'connectionId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // TTL for automatic cleanup of stale connections (2 hours per design)
      timeToLiveAttribute: 'TTL',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // GSI on ws-connections: query by memberId for broadcasting
    this.wsConnectionsTable.addGlobalSecondaryIndex({
      indexName: 'memberId-index',
      partitionKey: { name: 'memberId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ─── Outputs ─────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'MainTableName', { value: this.mainTable.tableName });
    new cdk.CfnOutput(this, 'AuditLogTableName', { value: this.auditLogTable.tableName });
    new cdk.CfnOutput(this, 'WsConnectionsTableName', { value: this.wsConnectionsTable.tableName });
  }
}
