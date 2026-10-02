import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

/**
 * AuthStack
 *
 * Provisions the Cognito User Pool for CLOIS:
 *  - Email verification required before account activation (Req 1.1, 1.3)
 *  - Password policy: min 12 chars, uppercase + lowercase + digit + special (Req 1.2)
 *  - TOTP MFA optional per user (Req 1.12)
 *  - Custom attributes: custom:memberId, custom:orgRoles
 *  - App Client (no client secret — SPA usage)
 */
export class AuthStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ─── User Pool ────────────────────────────────────────────────────────────
    this.userPool = new cognito.UserPool(this, 'CloisUserPool', {
      userPoolName: 'clois-user-pool',

      // Self-registration is allowed; email must be verified before activation
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },

      // Email verification is required
      userVerification: {
        emailSubject: 'Verify your CLOIS account email',
        emailBody:
          'Thank you for registering with CLOIS. Please verify your email address by clicking this link: {##Verify Email##}',
        emailStyle: cognito.VerificationEmailStyle.LINK,
      },

      // Password policy: min 12 chars, uppercase + lowercase + digit + special (Req 1.2)
      passwordPolicy: {
        minLength: 12,
        requireUppercase: true,
        requireLowercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: cdk.Duration.days(1),
      },

      // MFA: optional TOTP per user (Req 1.12)
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: {
        sms: false,
        otp: true, // TOTP
      },

      // Account recovery via verified email only
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,

      // Custom attributes
      customAttributes: {
        // Internal UUID for the Member
        memberId: new cognito.StringAttribute({ mutable: true, minLen: 1, maxLen: 128 }),
        // JSON map: { "orgId": "role" }
        orgRoles: new cognito.StringAttribute({ mutable: true, minLen: 0, maxLen: 2048 }),
      },

      // Keep deleted users for 30 days (data retention)
      keepOriginal: { email: true },

      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ─── App Client (no client secret — SPA) ─────────────────────────────────
    this.userPoolClient = this.userPool.addClient('CloisSpaClient', {
      userPoolClientName: 'clois-spa-client',
      generateSecret: false, // SPA cannot safely store a client secret

      authFlows: {
        userPassword: true,
        userSrp: true,
        custom: true,
      },

      // Token validity
      accessTokenValidity: cdk.Duration.hours(1),   // Req 1.6
      refreshTokenValidity: cdk.Duration.days(30),  // Req 1.6
      idTokenValidity: cdk.Duration.hours(1),

      // Prevent user-existence enumeration
      preventUserExistenceErrors: true,

      readAttributes: new cognito.ClientAttributes().withStandardAttributes({
        email: true,
        emailVerified: true,
      }).withCustomAttributes('memberId', 'orgRoles'),

      writeAttributes: new cognito.ClientAttributes().withStandardAttributes({
        email: true,
      }).withCustomAttributes('memberId', 'orgRoles'),
    });

    // ─── Outputs ─────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'UserPoolArn', { value: this.userPool.userPoolArn });
  }
}
