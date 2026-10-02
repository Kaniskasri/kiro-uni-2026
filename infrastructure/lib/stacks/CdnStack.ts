import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cloudfrontOrigins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface CdnStackProps extends cdk.StackProps {
  /** The S3 bucket containing the React SPA build artefacts */
  readonly frontendBucket: s3.IBucket;
}

/**
 * CdnStack
 *
 * Provisions a CloudFront distribution that serves the React SPA from the
 * frontend S3 bucket with:
 *  - redirect-to-https viewer protocol policy (HTTP 301 → HTTPS)
 *  - Origin Access Control (OAC) so CloudFront can read from the private bucket
 */
export class CdnStack extends cdk.Stack {
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: CdnStackProps) {
    super(scope, id, props);

    const { frontendBucket } = props;

    // ─── CloudFront Distribution ──────────────────────────────────────────────
    this.distribution = new cloudfront.Distribution(this, 'CloisDistribution', {
      comment: 'CLOIS React SPA CDN',
      defaultRootObject: 'index.html',

      defaultBehavior: {
        origin: new cloudfrontOrigins.S3Origin(frontendBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        compress: true,
      },

      // SPA fallback: return index.html for any 403/404 (React Router handles routing)
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
      ],

      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });

    // ─── Outputs ─────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: this.distribution.distributionDomainName,
    });
    new cdk.CfnOutput(this, 'DistributionId', {
      value: this.distribution.distributionId,
    });
  }
}
