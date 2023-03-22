/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Octokit } from '@octokit/rest';
import { ApolloClient, ApolloQueryResult, FetchResult, MutationOptions, NormalizedCacheObject, OperationVariables, QueryOptions } from 'apollo-boost';
import { RateLimiter } from 'limiter';
import * as vscode from 'vscode';
import Logger from '../common/logger';
import { ITelemetry } from '../common/telemetry';
import { RateLimit } from './graphql';

interface RestResponse {
	headers: {
		'x-ratelimit-limit': string;
		'x-ratelimit-remaining': string;
	}
}

export class RateLogger {
	private limiter: RateLimiter;
	private static ID = 'RateLimit';
	private hasLoggedLowRateLimit: boolean = false;

	constructor(private readonly telemetry: ITelemetry) {
		this.limiter = new RateLimiter({ tokensPerInterval: 120, interval: 'second' });
	}

	public logAndLimit(): boolean {
		if (!this.limiter.tryRemoveTokens(1)) {
			Logger.error('API call count has exceeded 100 calls in 1 second.', RateLogger.ID);
			// We have hit 100 requests in 1 second. This likely indicates a bug in the extension.
			/* __GDPR__
				"pr.highApiCallRate" : {}
			*/
			this.telemetry.sendTelemetryErrorEvent('pr.highApiCallRate');
			vscode.window.showErrorMessage(vscode.l10n.t('The GitHub Pull Requests extension is making too many requests to GitHub. This indicates a bug in the extension. Please file an issue on GitHub and include the output from "GitHub Pull Request".'));
			return false;
		}
		Logger.debug(`Extension rate limit remaining: ${this.limiter.getTokensRemaining()}`, RateLogger.ID);
		return true;
	}

	public async logRateLimit(info: string | undefined, result: Promise<{ data: { rateLimit: RateLimit | undefined } | undefined } | undefined>, isRest: boolean = false) {
		let rateLimitInfo;
		try {
			rateLimitInfo = (await result)?.data?.rateLimit;
		} catch (e) {
			// Ignore errors here since we're just trying to log the rate limit.
			return;
		}
		if ((rateLimitInfo?.limit ?? 5000) < 5000) {
			Logger.appendLine(`Unexpectedly low rate limit: ${rateLimitInfo?.limit}`, RateLogger.ID);
		}
		const remaining = `${isRest ? 'REST' : 'GraphQL'} Rate limit remaining: ${rateLimitInfo?.remaining}, ${info}`;
		if ((rateLimitInfo?.remaining ?? 1000) < 1000) {
			if (!this.hasLoggedLowRateLimit) {
				/* __GDPR__
					"pr.lowRateLimitRemaining" : {}
				*/
				this.telemetry.sendTelemetryErrorEvent('pr.lowRateLimitRemaining');
				this.hasLoggedLowRateLimit = true;
			}
			Logger.warn(remaining, RateLogger.ID);
		} else {
			Logger.debug(remaining, RateLogger.ID);
		}
	}

	public async logRestRateLimit(info: string | undefined, restResponse: Promise<RestResponse>) {
		let result;
		try {
			result = await restResponse;
		} catch (e) {
			// Ignore errors here since we're just trying to log the rate limit.
			return;
		}
		const rateLimit: RateLimit = {
			cost: -1,
			limit: Number(result.headers['x-ratelimit-limit']),
			remaining: Number(result.headers['x-ratelimit-remaining']),
			resetAt: ''
		};
		this.logRateLimit(info, Promise.resolve({ data: { rateLimit } }), true);
	}
}

export class LoggingApolloClient {
	constructor(private readonly _graphql: ApolloClient<NormalizedCacheObject>, private _rateLogger: RateLogger) { };

	query<T = any, TVariables = OperationVariables>(options: QueryOptions<TVariables>): Promise<ApolloQueryResult<T>> {
		if (this._rateLogger.logAndLimit()) {
			const result = this._graphql.query(options);
			this._rateLogger.logRateLimit((options.query.definitions[0] as { name: { value: string } | undefined }).name?.value, result as any);
			return result;
		} else {
			throw new Error('API call count has exceeded a rate limit.');
		}
	}

	mutate<T = any, TVariables = OperationVariables>(options: MutationOptions<T, TVariables>): Promise<FetchResult<T>> {
		if (this._rateLogger.logAndLimit()) {
			const result = this._graphql.mutate(options);
			this._rateLogger.logRateLimit(options.context, result as any);
			return result;
		} else {
			throw new Error('API call count has exceeded a rate limit.');
		}
	}
}

export class LoggingOctokit {
	constructor(public readonly api: Octokit, private _rateLogger: RateLogger) { };

	async call<T, U>(api: (T) => Promise<U>, args: T): Promise<U> {
		if (this._rateLogger.logAndLimit()) {
			const result = api(args);
			this._rateLogger.logRestRateLimit((api as unknown as { endpoint: { DEFAULTS: { url: string } | undefined } | undefined }).endpoint?.DEFAULTS?.url, result as Promise<unknown> as Promise<RestResponse>);
			return result;
		} else {
			throw new Error('API call count has exceeded a rate limit.');
		}
	}
}
