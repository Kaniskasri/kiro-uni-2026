// AuthStack snapshot tests
// Validates: password policy, MFA=OPTIONAL, custom attributes, token validity
// Requirements: 1.2, 1.6, 1.12, 19.4

import { describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { AuthStack } from '../lib/stacks/AuthStack';

function buildTemplate(): Template {
  const app = new cdk.App();
  const stack = new AuthStack(app, 'TestAuthStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  return Template.fromStack(stack);
}

describe('AuthStack', () => {
  it('matches snapshot', () => {
    expect(buildTemplate().toJSON()).toMatchSnapshot();
  });

  it('creates exactly 1 Cognito User Pool', () => {
    buildTemplate().resourceCountIs('AWS::Cognito::UserPool', 1);
  });

  it('user pool has correct password policy: min 12 chars with all complexity requirements', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      Policies: {
        PasswordPolicy: {
          MinimumLength: 12,
          RequireUppercase: true,
          RequireLowercase: true,
          RequireNumbers: true,
          RequireSymbols: true,
        },
      },
    });
  });

  it('user pool MFA is OPTIONAL (not OFF or REQUIRED)', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      MfaConfiguration: 'OPTIONAL',
    });
  });

  it('user pool supports TOTP software token MFA', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      EnabledMfas: Match.arrayWith(['SOFTWARE_TOKEN_MFA']),
    });
  });

  it('user pool has custom:memberId attribute', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      Schema: Match.arrayWith([
        Match.objectLike({
          Name: 'memberId',
          AttributeDataType: 'String',
          Mutable: true,
        }),
      ]),
    });
  });

  it('user pool has custom:orgRoles attribute', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      Schema: Match.arrayWith([
        Match.objectLike({
          Name: 'orgRoles',
          AttributeDataType: 'String',
          Mutable: true,
        }),
      ]),
    });
  });

  it('user pool requires email verification (AUTO_VERIFY_EMAIL)', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      AutoVerifiedAttributes: Match.arrayWith(['email']),
    });
  });

  it('creates exactly 1 App Client with no client secret', () => {
    const template = buildTemplate();
    const clients = template.findResources('AWS::Cognito::UserPoolClient');
    const clientKeys = Object.keys(clients);
    expect(clientKeys).toHaveLength(1);
    const client = clients[clientKeys[0]];
    // GenerateSecret absent or false means no client secret
    const props = (client as { Properties: Record<string, unknown> }).Properties;
    expect(props['GenerateSecret']).toBeFalsy();
  });

  it('app client has correct token validity: 1h access, 30d refresh', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      AccessTokenValidity: 60,       // minutes
      RefreshTokenValidity: 43200,   // minutes = 30 days
      TokenValidityUnits: Match.objectLike({
        AccessToken: 'minutes',
        RefreshToken: 'minutes',
      }),
    });
  });

  it('user pool self-sign-up is enabled', () => {
    const template = buildTemplate();
    // AllowAdminCreateUserOnly: false means self-sign-up is enabled
    const pools = template.findResources('AWS::Cognito::UserPool');
    const pool = Object.values(pools)[0] as { Properties: Record<string, unknown> };
    const adminCreateUser = pool.Properties['AdminCreateUserConfig'] as
      | { AllowAdminCreateUserOnly: boolean }
      | undefined;
    expect(adminCreateUser?.AllowAdminCreateUserOnly).toBeFalsy();
  });
});
