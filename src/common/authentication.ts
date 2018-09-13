export class AuthenticationError extends Error {
	name: string;
	stack?: string;
	constructor(public message: string) {
		super(message);
	}
}
