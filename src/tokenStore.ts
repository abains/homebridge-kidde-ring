/**
 * Ring rotates the refresh token on every login. We persist the rotated
 * token in Homebridge's storage dir so restarts keep working without the
 * user re-pasting a token. The token originally configured in config.json
 * is stored alongside it: if the user pastes a *new* token into the config,
 * the cache is considered stale and the configured token wins.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Logger } from './ringRestClient';

interface StoredTokens {
  configuredToken: string;
  currentToken: string;
}

export class TokenStore {
  private readonly filePath: string;

  constructor(storagePath: string, private readonly log: Logger) {
    this.filePath = join(storagePath, 'kidde-ring-token.json');
  }

  /** Return the freshest usable token for the given configured token. */
  resolve(configuredToken?: string): string | undefined {
    try {
      if (!existsSync(this.filePath)) {
        return configuredToken;
      }
      const stored = JSON.parse(readFileSync(this.filePath, 'utf8')) as StoredTokens;
      if (configuredToken && stored.configuredToken !== configuredToken) {
        // User supplied a new token — it takes precedence over the cache.
        return configuredToken;
      }
      return stored.currentToken || configuredToken;
    } catch (err) {
      this.log.warn(`Could not read token cache: ${err}`);
      return configuredToken;
    }
  }

  save(configuredToken: string | undefined, currentToken: string): void {
    try {
      const data: StoredTokens = {
        configuredToken: configuredToken ?? '',
        currentToken,
      };
      writeFileSync(this.filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
    } catch (err) {
      this.log.warn(`Could not persist rotated Ring token: ${err}`);
    }
  }
}
