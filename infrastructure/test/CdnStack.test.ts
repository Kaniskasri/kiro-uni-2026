// CdnStack snapshot tests
// Validates: REDIRECT_TO_HTTPS viewer protocol policy, SPA error responses
// Requirements: 19.3

import { describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { CdnStack } from '../lib/stacks/CdnStack';

function buildTemplate(): Template {
  const app = new cdk.App();
  // Create a stub bucket to satisfy the CdnStack dependency
  const storageStack = new cdk.Stack(app, 'TestStorageStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  const frontendBucket = new s3.Bucket(storageStack, 'FrontendBucket', {
    bucketName: 'test-frontend-bucket',
  });

  const cdnStack = new CdnStack(app, 'TestCdnStack', {
    env: { account: '123456789012', region: 'us-east-1' },
    frontendBucket,
  });

  return Template.fromStack(cdnStack);
}

describe('CdnStack', () => {
  it('matches snapshot', () => {
    expect(buildTemplate().toJSON()).toMatchSnapshot();
  });

  it('creates exactly 1 CloudFront distribution', () => {
    buildTemplate().resourceCountIs('AWS::CloudFront::Distribution', 1);
  });

  it('distribution has REDIRECT_TO_HTTPS viewer protocol policy', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        DefaultCacheBehavior: {
          ViewerProtocolPolicy: 'redirect-to-https',
        },
      },
    });
  });

  it('distribution has index.html as default root object', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        DefaultRootObject: 'index.html',
      },
    });
  });

  it('distribution has SPA 403 error response mapping to index.html', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        CustomErrorResponses: Match.arrayWith([
          Match.objectLike({
            ErrorCode: 403,
            ResponseCode: 200,
            ResponsePagePath: '/index.html',
          }),
        ]),
      },
    });
  });

  it('distribution has SPA 404 error response mapping to index.html', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        CustomErrorResponses: Match.arrayWith([
          Match.objectLike({
            ErrorCode: 404,
            ResponseCode: 200,
            ResponsePagePath: '/index.html',
          }),
        ]),
      },
    });
  });

  it('distribution is enabled', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        Enabled: true,
      },
    });
  });

  it('distribution uses PRICE_CLASS_100', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        PriceClass: 'PriceClass_100',
      },
    });
  });
});
