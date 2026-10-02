// StorageStack snapshot tests
// Validates: bucket lifecycle rules, public access blocked, 3-year reports retention
// Requirements: 10.7, 19.4

import { describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { StorageStack } from '../lib/stacks/StorageStack';

function buildTemplate(): Template {
  const app = new cdk.App();
  const stack = new StorageStack(app, 'TestStorageStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  return Template.fromStack(stack);
}

describe('StorageStack', () => {
  it('matches snapshot', () => {
    expect(buildTemplate().toJSON()).toMatchSnapshot();
  });

  it('creates exactly 2 S3 buckets', () => {
    buildTemplate().resourceCountIs('AWS::S3::Bucket', 2);
  });

  it('both buckets block all public access', () => {
    const template = buildTemplate();
    const buckets = template.findResources('AWS::S3::Bucket');
    for (const bucket of Object.values(buckets)) {
      const config = (bucket as { Properties: Record<string, unknown> }).Properties
        .PublicAccessBlockConfiguration as Record<string, boolean> | undefined;
      expect(config).toBeDefined();
      expect(config?.BlockPublicAcls).toBe(true);
      expect(config?.BlockPublicPolicy).toBe(true);
      expect(config?.IgnorePublicAcls).toBe(true);
      expect(config?.RestrictPublicBuckets).toBe(true);
    }
  });

  it('assets bucket has reports/ lifecycle rule with 1095-day expiration (3 years)', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Prefix: 'reports/',
            ExpirationInDays: 1095,
            Status: 'Enabled',
          }),
        ]),
      },
    });
  });

  it('assets bucket has qr-codes/ lifecycle rule transitioning to IA', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Prefix: 'qr-codes/',
            Status: 'Enabled',
            Transitions: Match.arrayWith([
              Match.objectLike({ StorageClass: 'STANDARD_IA' }),
            ]),
          }),
        ]),
      },
    });
  });

  it('assets bucket has exports/ lifecycle rule with 365-day expiration', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Prefix: 'exports/',
            ExpirationInDays: 365,
            Status: 'Enabled',
          }),
        ]),
      },
    });
  });

  it('assets bucket has data-exports/ lifecycle rule with 365-day expiration', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Prefix: 'data-exports/',
            ExpirationInDays: 365,
            Status: 'Enabled',
          }),
        ]),
      },
    });
  });

  it('both buckets use S3-managed encryption', () => {
    const template = buildTemplate();
    const buckets = template.findResources('AWS::S3::Bucket');
    for (const bucket of Object.values(buckets)) {
      const props = (bucket as { Properties: Record<string, unknown> }).Properties;
      const encryption = props.BucketEncryption as
        | { ServerSideEncryptionConfiguration: Array<{ ServerSideEncryptionByDefault: { SSEAlgorithm: string } }> }
        | undefined;
      expect(encryption).toBeDefined();
      expect(
        encryption?.ServerSideEncryptionConfiguration[0]?.ServerSideEncryptionByDefault?.SSEAlgorithm,
      ).toBe('AES256');
    }
  });
});
