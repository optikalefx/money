'use node';

import { internalAction } from './_generated/server';
import { importPKCS8, SignJWT } from 'jose';

// Signing lives in a Node action so JWT crypto runs on a runtime with guaranteed support.
// The `kid` and `alg` here must match the key published in `/.well-known/jwks.json`, and
// `aud`/`iss` must match `auth.config.ts`.
const ALG = 'RS256';
const KID = 'owner-key';
const AUDIENCE = 'money-app';

export const mintOwnerToken = internalAction({
	args: {},
	handler: async (): Promise<string> => {
		const pkcs8 = process.env.JWT_PRIVATE_KEY;
		if (!pkcs8) {
			throw new Error('JWT_PRIVATE_KEY is not set. Run `npm run auth:setup`.');
		}
		const privateKey = await importPKCS8(pkcs8, ALG);
		return await new SignJWT({})
			.setProtectedHeader({ alg: ALG, kid: KID, typ: 'JWT' })
			.setSubject('owner')
			.setIssuer(process.env.CONVEX_SITE_URL ?? '')
			.setAudience(AUDIENCE)
			.setIssuedAt()
			.setExpirationTime('30d')
			.sign(privateKey);
	}
});
