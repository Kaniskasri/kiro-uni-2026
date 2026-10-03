export interface RegisterRequest {
  email: string;
  password: string;
  name: string;
}

export interface LoginRequest {
  email: string;
  password: string;
  totpCode?: string;
}

export interface VerifyEmailRequest {
  email: string;
  code: string;
}

export interface RefreshRequest {
  refreshToken: string;
}

export interface ForgotPasswordRequest {
  email: string;
}

export interface ResetPasswordRequest {
  email: string;
  code: string;
  newPassword: string;
}

export interface MfaToggleRequest {
  accessToken: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  expiresIn: number;
}

export interface AuthResponse {
  message: string;
  tokens?: AuthTokens;
}