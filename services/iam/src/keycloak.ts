import { randomBytes } from 'node:crypto';

export interface KeycloakAdminConfig {
  url: string;
  realm: string;
  user: string;
  password: string;
}

/**
 * Just enough of the Keycloak admin REST API to create an account for an invited person, with a
 * temporary password they must change at first sign-in. In AWS, Cognito or the customer's SSO owns
 * accounts instead, and this is not configured.
 */
export class KeycloakAdmin {
  constructor(private readonly cfg: KeycloakAdminConfig) {}

  /** Returns the temporary password, or null when the account already exists (they keep their password). */
  async createUser(email: string, name: string): Promise<string | null> {
    const token = await this.adminToken();
    const [firstName, ...rest] = name.split(' ');
    // Mixed classes so it passes the realm's password policy; shown once to the inviting admin.
    const password = `Tb-${randomBytes(9).toString('base64url')}9a`;
    const res = await fetch(`${this.cfg.url}/admin/realms/${this.cfg.realm}/users`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        username: email,
        email,
        firstName,
        lastName: rest.join(' ') || undefined,
        enabled: true,
        emailVerified: true,
        credentials: [{ type: 'password', value: password, temporary: true }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 409) return null;
    if (!res.ok) throw new Error(`Keycloak refused to create the user (${res.status})`);
    return password;
  }

  private async adminToken(): Promise<string> {
    const res = await fetch(`${this.cfg.url}/realms/master/protocol/openid-connect/token`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'admin-cli',
        username: this.cfg.user,
        password: this.cfg.password,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Keycloak admin sign-in failed (${res.status})`);
    return ((await res.json()) as { access_token: string }).access_token;
  }
}
