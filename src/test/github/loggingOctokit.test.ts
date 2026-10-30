/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { default as assert } from 'assert';
import { createSandbox } from 'sinon';
import { GitHubRef } from '../../common/githubRef';
import { GitHubServerType } from '../../common/authentication';
import { Protocol } from '../../common/protocol';
import { GitHubRemote } from '../../common/remote';
import { compareCommits, isAuthError, LoggingOctokit, RateLogger } from '../../github/loggingOctokit';
import { MockTelemetry } from '../mocks/mockTelemetry';
import { QueryProvider } from '../mocks/queryProvider';

describe('loggingOctokit', () => {
	describe('compareCommits', () => {
		const remote = new GitHubRemote('origin', 'github/test', new Protocol('https://github.com/github/test.git'), GitHubServerType.GitHubDotCom);
		const base = new GitHubRef('main', 'github:main', 'base-sha', 'https://github.com/github/test.git', 'github', 'test', false);
		const head = new GitHubRef('feature', 'github:feature', 'head-sha', 'https://github.com/github/test.git', 'github', 'test', false);

		it('uses a three-dot comparison when excluding merge commits', async () => {
			const sinon = createSandbox();
			try {
				const queryProvider = new QueryProvider(sinon);
				const octokit = new LoggingOctokit(queryProvider.octokit, new RateLogger(new MockTelemetry(), true));
				queryProvider.expectOctokitRequest(['repos', 'compareCommitsWithBasehead'], [{
					repo: 'test',
					owner: 'github',
					basehead: 'github:review-sha...github:head-sha',
				}], {
					files: [],
					merge_base_commit: { sha: 'merge-base-sha' },
				});

				const result = await compareCommits(remote, octokit, base, head, 'review-sha', 1, 'test', true);

				assert.deepStrictEqual(result, { mergeBaseSha: 'merge-base-sha', files: [] });
			} finally {
				sinon.restore();
			}
		});

		it('uses the standard comparison by default', async () => {
			const sinon = createSandbox();
			try {
				const queryProvider = new QueryProvider(sinon);
				const octokit = new LoggingOctokit(queryProvider.octokit, new RateLogger(new MockTelemetry(), true));
				queryProvider.expectOctokitRequest(['repos', 'compareCommits'], [{
					repo: 'test',
					owner: 'github',
					base: 'github:review-sha',
					head: 'github:head-sha',
				}], {
					files: [],
					merge_base_commit: { sha: 'merge-base-sha' },
				});

				const result = await compareCommits(remote, octokit, base, head, 'review-sha', 1, 'test');

				assert.deepStrictEqual(result, { mergeBaseSha: 'merge-base-sha', files: [] });
			} finally {
				sinon.restore();
			}
		});
	});

	describe('isAuthError', () => {
		it('returns true for an Octokit-style 401 with "Bad credentials" message', () => {
			const e: any = new Error('Bad credentials');
			e.status = 401;
			assert.strictEqual(isAuthError(e), true);
		});

		it('returns true for an error whose message is exactly "Bad credentials"', () => {
			assert.strictEqual(isAuthError(new Error('Bad credentials')), true);
		});

		it('returns true for an error whose message includes "Bad credentials"', () => {
			assert.strictEqual(isAuthError(new Error('HttpError: Bad credentials - https://docs.github.com/rest')), true);
		});

		it('returns true for a GraphQL networkError with statusCode 401', () => {
			const e: any = new Error('Network error');
			e.networkError = { statusCode: 401 };
			assert.strictEqual(isAuthError(e), true);
		});

		it('returns true for a GraphQL error message including "401 Unauthorized"', () => {
			assert.strictEqual(isAuthError(new Error('Response not successful: Received status code 401 Unauthorized')), true);
		});

		it('returns false for unrelated errors', () => {
			const e: any = new Error('Not Found');
			e.status = 404;
			assert.strictEqual(isAuthError(e), false);
			assert.strictEqual(isAuthError(new Error('Server Error')), false);
			assert.strictEqual(isAuthError(undefined), false);
			assert.strictEqual(isAuthError(null), false);
			assert.strictEqual(isAuthError('Bad credentials'), false);
		});
	});

	describe('RateLogger.logApiError', () => {
		it('invokes the auth error handler when the API call fails with a 401/Bad credentials', async () => {
			const telemetry = new MockTelemetry();
			let handlerCalls = 0;
			const handler = () => { handlerCalls++; };
			const rateLogger = new RateLogger(telemetry, false, handler);

			const e: any = new Error('Bad credentials');
			e.status = 401;
			rateLogger.logApiError('/test', Promise.reject(e));

			// allow microtasks to run
			await new Promise(resolve => setImmediate(resolve));
			assert.strictEqual(handlerCalls, 1);
		});

		it('does not invoke the auth error handler for non-auth errors', async () => {
			const telemetry = new MockTelemetry();
			let handlerCalls = 0;
			const handler = () => { handlerCalls++; };
			const rateLogger = new RateLogger(telemetry, false, handler);

			const e: any = new Error('Not Found');
			e.status = 404;
			rateLogger.logApiError('/test', Promise.reject(e));

			await new Promise(resolve => setImmediate(resolve));
			assert.strictEqual(handlerCalls, 0);
		});

		it('swallows exceptions thrown by the auth error handler', async () => {
			const telemetry = new MockTelemetry();
			const handler = () => { throw new Error('handler failure'); };
			const rateLogger = new RateLogger(telemetry, false, handler);

			const e: any = new Error('Bad credentials');
			e.status = 401;
			// Should not throw.
			rateLogger.logApiError('/test', Promise.reject(e));
			await new Promise(resolve => setImmediate(resolve));
		});

		it('works without an auth error handler', async () => {
			const telemetry = new MockTelemetry();
			const rateLogger = new RateLogger(telemetry, false);

			const e: any = new Error('Bad credentials');
			e.status = 401;
			rateLogger.logApiError('/test', Promise.reject(e));
			await new Promise(resolve => setImmediate(resolve));
		});
	});
});
