#!/usr/bin/env node
/**
 * Interactive helper to obtain a Ring refresh token (handles 2FA).
 *
 *   npx -p homebridge-kidde-ring kidde-ring-auth
 *
 * Paste the printed token into the plugin's "refreshToken" config field.
 */

import * as readline from 'readline/promises';
import { stdin, stdout } from 'process';
import { RingRestClient, Ring2FARequired } from './ringRestClient';

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  console.log('Ring account login for homebridge-kidde-ring');
  console.log('(Credentials are sent only to oauth.ring.com and are not stored.)\n');

  const email = await rl.question('Ring account email: ');
  const password = await rl.question('Ring account password: ');

  const client = new RingRestClient({ email: email.trim(), password });

  let refreshToken: string;
  try {
    refreshToken = await client.authenticate();
  } catch (err) {
    if (err instanceof Ring2FARequired) {
      let prompt = err.prompt;
      for (;;) {
        const code = (await rl.question(`${prompt}: `)).trim();
        try {
          refreshToken = await client.authenticate(code);
          break;
        } catch (retryErr) {
          if (retryErr instanceof Ring2FARequired) {
            prompt = retryErr.prompt;
            continue;
          }
          throw retryErr;
        }
      }
    } else {
      throw err;
    }
  }

  rl.close();

  console.log('\nSuccess! Add this refreshToken to your Homebridge config:\n');
  console.log(refreshToken);
  console.log(
    '\nExample platform config:\n' +
    JSON.stringify(
      {
        platform: 'KiddeRing',
        name: 'Kidde Ring',
        refreshToken: '<token above>',
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(`\nAuthentication failed: ${err.message ?? err}`);
  process.exit(1);
});
