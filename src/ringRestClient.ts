/**
 * Lean Ring REST client: OAuth token exchange, 2FA challenges, session
 * creation, and authenticated GET requests with automatic token refresh.
 *
 * Protocol notes (mirrors ring-client-api and ha-ring-smoke-detectors):
 * - Exchange a refresh token (or email+password) for an access token at
 *   https://oauth.ring.com/oauth/token. A 412 response means a 2FA code
 *   is required.
 * - Ring rotates refresh tokens on every exchange; onTokenUpdate lets the
 *   caller persist the rotated token so logins survive restarts.
 * - The refresh token we hand out is base64-encoded JSON
 *   { rt: "<actual token>", hid: "<hardware id>" } so the same hardware
 *   identity is reused across sessions (Ring ties 2FA approval to it).
 */

import { randomUUID } from 'crypto';
import { OAUTH_URL, CLIENT_API_BASE, API_VERSION } from './settings';

export class RingAuthError extends Error {}

export class Ring2FARequired extends Error {
  constructor(public readonly prompt: string) {
    super(prompt);
  }
}

interface AuthConfig {
  rt: string;
  hid?: string;
}

export interface Logger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

function parseAuthConfig(rawToken?: string): AuthConfig | undefined {
  if (!rawToken) {
    return undefined;
  }
  try {
    const config = JSON.parse(Buffer.from(rawToken, 'base64').toString('ascii'));
    if (config && config.rt) {
      return config;
    }
    return { rt: rawToken };
  } catch {
    return { rt: rawToken };
  }
}

export interface RingRestClientOptions {
  refreshToken?: string;
  email?: string;
  password?: string;
  log?: Logger;
  onTokenUpdate?: (newToken: string) => void;
}

export class RingRestClient {
  public refreshToken?: string;

  private readonly email?: string;
  private readonly password?: string;
  private readonly log?: Logger;
  private readonly onTokenUpdate?: (newToken: string) => void;
  private authConfig?: AuthConfig;
  private readonly hardwareId: string;
  private accessToken?: string;
  private sessionCreated = false;
  private authPromise?: Promise<string>;

  constructor(options: RingRestClientOptions) {
    this.refreshToken = options.refreshToken;
    this.email = options.email;
    this.password = options.password;
    this.log = options.log;
    this.onTokenUpdate = options.onTokenUpdate;
    this.authConfig = parseAuthConfig(options.refreshToken);
    this.hardwareId = this.authConfig?.hid ?? randomUUID();
  }

  /**
   * Authenticate with Ring and return the (possibly rotated) refresh token.
   * Throws Ring2FARequired when Ring asks for a verification code.
   */
  async authenticate(twoFactorCode?: string): Promise<string> {
    let grantData: Record<string, string>;
    if (this.authConfig?.rt && !twoFactorCode) {
      grantData = {
        grant_type: 'refresh_token',
        refresh_token: this.authConfig.rt,
      };
    } else if (this.email && this.password) {
      grantData = {
        grant_type: 'password',
        username: this.email,
        password: this.password,
      };
    } else {
      throw new RingAuthError(
        'No Ring credentials available. Configure a refreshToken (recommended — run "kidde-ring-auth") or email/password.',
      );
    }

    const response = await fetch(OAUTH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        '2fa-support': 'true',
        '2fa-code': twoFactorCode ?? '',
        'hardware_id': this.hardwareId,
        'User-Agent': 'android:com.ringapp',
      },
      body: JSON.stringify({
        client_id: 'ring_official_android',
        scope: 'client',
        ...grantData,
      }),
    });

    if (response.status === 412) {
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      let prompt = 'Please enter the code sent to your text/email';
      if (typeof body.tsv_state === 'string') {
        prompt = body.tsv_state === 'totp'
          ? 'Please enter the code from your authenticator app'
          : `Please enter the code sent to ${body.phone ?? 'your phone'} via ${body.tsv_state}`;
      }
      throw new Ring2FARequired(prompt);
    }

    if (response.status === 400) {
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      const error = String(body.error ?? '');
      if (error.startsWith('Verification Code')) {
        throw new Ring2FARequired('Invalid code entered. Please try again.');
      }
      throw new RingAuthError(`Ring authentication failed: ${error || response.statusText}`);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      // A dead refresh token: fall back to email/password if configured.
      if (grantData.grant_type === 'refresh_token' && this.email && this.password) {
        this.log?.warn('Ring refresh token was rejected; retrying with email/password');
        this.authConfig = undefined;
        this.refreshToken = undefined;
        return this.authenticate(twoFactorCode);
      }
      throw new RingAuthError(`Ring authentication failed (${response.status}): ${text}`);
    }

    const data = await response.json() as { access_token: string; refresh_token: string };
    this.accessToken = data.access_token;
    this.authConfig = { rt: data.refresh_token, hid: this.hardwareId };
    this.refreshToken = Buffer.from(JSON.stringify(this.authConfig)).toString('base64');
    this.onTokenUpdate?.(this.refreshToken);
    return this.refreshToken;
  }

  private async ensureAccessToken(): Promise<void> {
    if (this.accessToken) {
      return;
    }
    // Serialize concurrent callers onto one auth request.
    if (!this.authPromise) {
      this.authPromise = this.authenticate().finally(() => {
        this.authPromise = undefined;
      });
    }
    await this.authPromise;
  }

  /** Register this client as a "device" with Ring (required before API calls). */
  private async ensureSession(): Promise<void> {
    if (this.sessionCreated) {
      return;
    }
    await this.ensureAccessToken();
    try {
      const response = await fetch(`${CLIENT_API_BASE}session`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          device: {
            hardware_id: this.hardwareId,
            metadata: {
              api_version: API_VERSION,
              device_model: 'homebridge-kidde-ring',
            },
            os: 'android',
          },
        }),
      });
      if (response.status === 401) {
        this.accessToken = undefined;
        await this.ensureAccessToken();
        return this.ensureSession();
      }
      this.sessionCreated = true;
    } catch (err) {
      this.log?.warn(`Ring session creation failed (continuing anyway): ${err}`);
      this.sessionCreated = true;
    }
  }

  /** Authenticated GET with retry on auth expiry, rate limiting, and gateway timeouts. */
  async request<T = unknown>(url: string): Promise<T> {
    await this.ensureSession();

    for (let attempt = 0; attempt < 3; attempt++) {
      let response: Response;
      try {
        response = await fetch(url, {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'hardware_id': this.hardwareId,
            'User-Agent': 'android:com.ringapp',
            'Accept': 'application/json',
          },
        });
      } catch (err) {
        if (attempt === 2) {
          throw err;
        }
        await delay(5000);
        continue;
      }

      if (response.status === 401) {
        this.accessToken = undefined;
        this.sessionCreated = false;
        await this.ensureSession();
        continue;
      }
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get('retry-after')) || 60;
        this.log?.warn(`Ring API rate limited; waiting ${retryAfter}s`);
        await delay((retryAfter + 1) * 1000);
        continue;
      }
      if (response.status === 504) {
        await delay(5000);
        continue;
      }
      if (!response.ok) {
        throw new RingAuthError(`Ring API request failed (${response.status}): ${url}`);
      }
      return await response.json() as T;
    }

    throw new RingAuthError(`Ring API request to ${url} failed after retries`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
