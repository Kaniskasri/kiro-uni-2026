import {
  CognitoIdentityProviderClient,
  SignUpCommand,
  ConfirmSignUpCommand,
  InitiateAuthCommand,
  ForgotPasswordCommand,
  ConfirmForgotPasswordCommand,
  AssociateSoftwareTokenCommand,
  VerifySoftwareTokenCommand,
  SetUserMFAPreferenceCommand,
  RespondToAuthChallengeCommand,
  AuthFlowType,
  ChallengeNameType,
} from '@aws-sdk/client-cognito-identity-provider';
import { AuthTokens } from './types';

const client = new CognitoIdentityProviderClient({ region: process.env['COGNITO_REGION'] ?? 'us-east-1' });
const CLIENT_ID = process.env['COGNITO_CLIENT_ID'] ?? '';

// Password policy: min 12 chars, uppercase, lowercase, digit, special char (Req 1.2)
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]).{12,}$/;

export function validatePassword(password: string): void {
  if (!PASSWORD_REGEX.test(password)) {
    throw Object.assign(
      new Error(
        'Password must be at least 12 characters and include uppercase, lowercase, digit, and special character.',
      ),
      { statusCode: 400, errorCode: 'auth.weak_password' },
    );
  }
}

export async function register(email: string, password: string, name: string): Promise<void> {
  validatePassword(password);
  try {
    await client.send(
      new SignUpCommand({
        ClientId: CLIENT_ID,
        Username: email,
        Password: password,
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'name', Value: name },
        ],
      }),
    );
  } catch (err) {
    const error = err as { name?: string };
    if (error.name === 'UsernameExistsException') {
      throw Object.assign(new Error('An account with this email already exists.'), {
        statusCode: 409,
        errorCode: 'auth.email_already_exists',
      });
    }
    throw err;
  }
}

export async function verifyEmail(email: string, code: string): Promise<void> {
  try {
    await client.send(
      new ConfirmSignUpCommand({ ClientId: CLIENT_ID, Username: email, ConfirmationCode: code }),
    );
  } catch (err) {
    const error = err as { name?: string };
    if (error.name === 'ExpiredCodeException') {
      throw Object.assign(new Error('Verification code has expired. Please request a new one.'), {
        statusCode: 400,
        errorCode: 'auth.code_expired',
      });
    }
    if (error.name === 'CodeMismatchException') {
      throw Object.assign(new Error('Invalid verification code.'), {
        statusCode: 400,
        errorCode: 'auth.invalid_code',
      });
    }
    throw err;
  }
}

export async function login(
  email: string,
  password: string,
  totpCode?: string,
): Promise<AuthTokens> {
  const response = await client.send(
    new InitiateAuthCommand({
      AuthFlow: AuthFlowType.USER_PASSWORD_AUTH,
      ClientId: CLIENT_ID,
      AuthParameters: { USERNAME: email, PASSWORD: password },
    }),
  );

  // Handle MFA challenge
  if (response.ChallengeName === ChallengeNameType.SOFTWARE_TOKEN_MFA) {
    if (!totpCode) {
      throw Object.assign(new Error('TOTP code required for MFA-enabled account.'), {
        statusCode: 400,
        errorCode: 'auth.mfa_required',
      });
    }
    const mfaResponse = await client.send(
      new RespondToAuthChallengeCommand({
        ClientId: CLIENT_ID,
        ChallengeName: ChallengeNameType.SOFTWARE_TOKEN_MFA,
        Session: response.Session,
        ChallengeResponses: {
          USERNAME: email,
          SOFTWARE_TOKEN_MFA_CODE: totpCode,
        },
      }),
    );
    return extractTokens(mfaResponse.AuthenticationResult);
  }

  return extractTokens(response.AuthenticationResult);
}

function extractTokens(result: { AccessToken?: string; RefreshToken?: string; IdToken?: string; ExpiresIn?: number } | undefined): AuthTokens {
  if (!result?.AccessToken || !result.RefreshToken || !result.IdToken) {
    throw Object.assign(new Error('Authentication failed.'), {
      statusCode: 401,
      errorCode: 'auth.login_failed',
    });
  }
  return {
    accessToken: result.AccessToken,
    refreshToken: result.RefreshToken,
    idToken: result.IdToken,
    expiresIn: result.ExpiresIn ?? 3600,
  };
}

export async function refreshTokens(refreshToken: string): Promise<AuthTokens> {
  try {
    const response = await client.send(
      new InitiateAuthCommand({
        AuthFlow: AuthFlowType.REFRESH_TOKEN_AUTH,
        ClientId: CLIENT_ID,
        AuthParameters: { REFRESH_TOKEN: refreshToken },
      }),
    );
    return extractTokens(response.AuthenticationResult);
  } catch (err) {
    const error = err as { name?: string };
    if (error.name === 'NotAuthorizedException') {
      throw Object.assign(new Error('Refresh token is expired or invalid.'), {
        statusCode: 401,
        errorCode: 'auth.invalid_refresh_token',
      });
    }
    throw err;
  }
}

export async function forgotPassword(email: string): Promise<void> {
  // Cognito invalidates prior reset codes when a new one is requested (Req 1.9)
  await client.send(new ForgotPasswordCommand({ ClientId: CLIENT_ID, Username: email }));
}

export async function resetPassword(email: string, code: string, newPassword: string): Promise<void> {
  validatePassword(newPassword);
  try {
    await client.send(
      new ConfirmForgotPasswordCommand({
        ClientId: CLIENT_ID,
        Username: email,
        ConfirmationCode: code,
        Password: newPassword,
      }),
    );
  } catch (err) {
    const error = err as { name?: string };
    if (error.name === 'ExpiredCodeException') {
      throw Object.assign(new Error('Password reset link has expired.'), {
        statusCode: 400,
        errorCode: 'auth.reset_link_expired',
      });
    }
    if (error.name === 'CodeMismatchException') {
      throw Object.assign(new Error('Invalid or already-used reset code.'), {
        statusCode: 400,
        errorCode: 'auth.invalid_reset_code',
      });
    }
    throw err;
  }
}

export async function enableMfa(accessToken: string): Promise<string> {
  const assocResponse = await client.send(
    new AssociateSoftwareTokenCommand({ AccessToken: accessToken }),
  );
  return assocResponse.SecretCode ?? '';
}

export async function verifyAndEnableMfa(accessToken: string, totpCode: string): Promise<void> {
  await client.send(
    new VerifySoftwareTokenCommand({ AccessToken: accessToken, UserCode: totpCode }),
  );
  await client.send(
    new SetUserMFAPreferenceCommand({
      AccessToken: accessToken,
      SoftwareTokenMfaSettings: { Enabled: true, PreferredMfa: true },
    }),
  );
}

export async function disableMfa(accessToken: string): Promise<void> {
  await client.send(
    new SetUserMFAPreferenceCommand({
      AccessToken: accessToken,
      SoftwareTokenMfaSettings: { Enabled: false, PreferredMfa: false },
    }),
  );
}