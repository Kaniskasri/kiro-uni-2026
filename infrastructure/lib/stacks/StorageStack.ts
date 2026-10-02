import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

/**
 * StorageStack
 *
 * Provisions S3 buckets:
 *  - Frontend assets bucket (served via CloudFront)
 *  - Application assets bucket (QR codes, exports, reports, data-exports)
 *    with lifecycle policies:
 *      - reports/ prefix: 3-year (1095 day) retention (Req 10.7)
 *      - qr-codes/ prefix: transition to IA after 30 days
 *      - exports/, data-exports/: transition to IA after 30 days, expire after 365 days
 *
 * All buckets block public access — assets are served via pre-signed URLs only.
 */
export class StorageStack extends cdk.Stack {
  /** S3 bucket serving the React SPA (source for CloudFront) */
  public readonly frontendBucket: s3.Bucket;
  /** S3 bucket for application-generated assets */
  public readonly assetsBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ─── Frontend assets bucket ───────────────────────────────────────────────
    this.frontendBucket = new s3.Bucket(this, 'FrontendBucket', {
      bucketName: `clois-frontend-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
    });

    // ─── Application assets bucket ────────────────────────────────────────────
    this.assetsBucket = new s3.Bucket(this, 'AssetsBucket', {
      bucketName: `clois-assets-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
      lifecycleRules: [
        // reports/ — 3-year (1095 day) minimum retention (Req 10.7)
        {
          id: 'reports-retention-3-years',
          prefix: 'reports/',
          expiration: cdk.Duration.days(1095),
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(90),
            },
            {
              storageClass: s3.StorageClass.GLACIER,
              transitionAfter: cdk.Duration.days(365),
            },
          ],
        },
        // qr-codes/ — move to IA after 30 days (accessed infrequently after event)
        {
          id: 'qr-codes-ia-transition',
          prefix: 'qr-codes/',
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(30),
            },
          ],
        },
        // exports/ — expire after 1 year
        {
          id: 'exports-expiry-1-year',
          prefix: 'exports/',
          expiration: cdk.Duration.days(365),
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(30),
            },
          ],
        },
        // data-exports/ — expire after 1 year (GDPR data exports)
        {
          id: 'data-exports-expiry-1-year',
          prefix: 'data-exports/',
          expiration: cdk.Duration.days(365),
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(30),
            },
          ],
        },
      ],
    });

    // ─── Outputs ─────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'FrontendBucketName', { value: this.frontendBucket.bucketName });
    new cdk.CfnOutput(this, 'AssetsBucketName', { value: this.assetsBucket.bucketName });
  }
}
