export class AuthenticationError extends Error {
	name: string;
	stack?: string;
	constructor(public message: string) {
		super(message);
	}
}

export function isSamlError(e: {message?: string}): boolean {
	return !!e.message?.startsWith('Resource protected by organization SAML enforcement.');
}
