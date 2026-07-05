// Convex verifies incoming JWTs against this provider. We issue our own tokens from
// `/auth/login` (signed in `authNode.ts`) and publish the matching public key at
// `/.well-known/jwks.json` (served in `http.ts`). `issuer` must equal the token's `iss`
// claim and `applicationID` must equal its `aud` claim — both set when the token is minted.
const siteUrl = process.env.CONVEX_SITE_URL ?? '';

export default {
	providers: [
		{
			type: 'customJwt',
			applicationID: 'money-app',
			issuer: siteUrl,
			jwks: `${siteUrl}/.well-known/jwks.json`,
			algorithm: 'RS256'
		}
	]
};
