// DatabaseStack snapshot tests
// Validates: GSI count, table names, audit log append-only policy, TTL on ws-connections
// Requirements: 1.2, 16.3, 19.4

import { describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { DatabaseStack } from '../lib/stacks/DatabaseStack';

function buildTemplate(): Template {
  const app = new cdk.App();
  const stack = new DatabaseStack(app, 'TestDatabaseStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  return Template.fromStack(stack);
}

describe('DatabaseStack', () => {
  it('matches snapshot', () => {
    expect(buildTemplate().toJSON()).toMatchSnapshot();
  });

  it('creates clois-main table with correct key schema', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'clois-main',
      KeySchema: Match.arrayWith([
        Match.objectLike({ AttributeName: 'PK', KeyType: 'HASH' }),
        Match.objectLike({ AttributeName: 'SK', KeyType: 'RANGE' }),
      ]),
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  it('creates clois-main with exactly 4 GSIs', () => {
    const template = buildTemplate();
    const tables = template.findResources('AWS::DynamoDB::Table', {
      Properties: { TableName: 'clois-main' },
    });
    const tableKeys = Object.keys(tables);
    expect(tableKeys).toHaveLength(1);
    const mainTable = tables[tableKeys[0]];
    const gsis: unknown[] = mainTable.Properties.GlobalSecondaryIndexes ?? [];
    expect(gsis).toHaveLength(4);
  });

  it('clois-main GSIs have correct names', () => {
    const template = buildTemplate();
    const tables = template.findResources('AWS::DynamoDB::Table', {
      Properties: { TableName: 'clois-main' },
    });
    const mainTable = tables[Object.keys(tables)[0]];
    const gsiNames: string[] = (mainTable.Properties.GlobalSecondaryIndexes as Array<{ IndexName: string }>).map(
      (g) => g.IndexName,
    );
    expect(gsiNames).toContain('GSI1');
    expect(gsiNames).toContain('GSI2');
    expect(gsiNames).toContain('GSI3');
    expect(gsiNames).toContain('GSI4');
  });

  it('creates clois-audit-log table', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'clois-audit-log',
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  it('audit log table has resource-based policy denying DeleteItem and UpdateItem', () => {
    const template = buildTemplate();
    // AWS::DynamoDB::ResourcePolicy resource is created with Deny effect
    template.hasResourceProperties('AWS::DynamoDB::ResourcePolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Action: Match.arrayWith([
              'dynamodb:DeleteItem',
              'dynamodb:UpdateItem',
            ]),
          }),
        ]),
      },
    });
  });

  it('creates clois-ws-connections table with TTL enabled', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'clois-ws-connections',
      TimeToLiveSpecification: {
        AttributeName: 'TTL',
        Enabled: true,
      },
    });
  });

  it('clois-main has point-in-time recovery enabled', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'clois-main',
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: true,
      },
    });
  });

  it('clois-audit-log has point-in-time recovery enabled', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'clois-audit-log',
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: true,
      },
    });
  });

  it('creates exactly 3 DynamoDB tables', () => {
    const template = buildTemplate();
    template.resourceCountIs('AWS::DynamoDB::Table', 3);
  });
});
