// One-time owner-auth provisioning. Generates an RS256 key pair, publishes the public key as a
// JWKS, and sets the owner password — all as Convex environment variables. Re-run to rotate.
//
//   npm run auth:setup            # provisions the dev deployment
//   npm run auth:setup -- --prod  # provisions the production deployment
//
// Values are piped to `convex env set` via stdin (never argv), so the multiline private key and
// the password stay out of your shell history and dodge CLI flag parsing (the key starts with
// `-----BEGIN`, which the arg parser would otherwise read as an option).

import { generateKeyPair, exportPKCS8, exportJWK } from 'jose';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';

const prod = process.argv.includes('--prod');
const target = prod ? ['--prod'] : [];
const KID = 'owner-key'; // must match authNode.ts

const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
const pkcs8 = await exportPKCS8(privateKey);
const jwk = await exportJWK(publicKey);
const jwks = JSON.stringify({ keys: [{ ...jwk, kid: KID, use: 'sig', alg: 'RS256' }] });

const password = (await askHidden(`Choose an owner password (${prod ? 'PROD' : 'dev'}): `)).trim();
if (!password) {
	console.error('A password is required.');
	process.exit(1);
}

// Pipe the value on stdin (`--force` so re-runs rotate cleanly instead of refusing a changed value).
function setEnv(key, value) {
	execFileSync('npx', ['convex', 'env', 'set', '--force', ...target, key], {
		input: value,
		stdio: ['pipe', 'inherit', 'inherit']
	});
}

setEnv('JWT_PRIVATE_KEY', pkcs8);
setEnv('JWKS', jwks);
setEnv('OWNER_PASSWORD', password);

console.log(
	`\n✓ Owner auth provisioned on ${prod ? 'production' : 'dev'}. Sign in with your password.`
);

// Prompt without echoing keystrokes, so a pasted password isn't left on screen.
function askHidden(query) {
	return new Promise((resolve) => {
		const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
		let muted = false;
		rl._writeToOutput = (str) => {
			if (!muted) rl.output.write(str);
		};
		rl.question(query, (value) => {
			rl.close();
			process.stdout.write('\n');
			resolve(value);
		});
		muted = true; // set after the prompt is printed, before keystrokes arrive
	});
}
