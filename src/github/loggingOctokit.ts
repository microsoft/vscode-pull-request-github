/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Octokit } from '@octokit/rest';
import { ApolloClient, ApolloQueryResult, FetchResult, MutationOptions, NormalizedCacheObject, OperationVariables, QueryOptions } from 'apollo-boost';
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
	private static ID = 'RateLimit';
	private hasLoggedLowRateLimit: boolean = false;

	constructor(private readonly telemetry: ITelemetry) { }

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
		const result = this._graphql.query(options);
		this._rateLogger.logRateLimit((options.query.definitions[0] as { name: { value: string } | undefined }).name?.value, result as any);
		return result;
	}

	mutate<T = any, TVariables = OperationVariables>(options: MutationOptions<T, TVariables>): Promise<FetchResult<T>> {
		const result = this._graphql.mutate(options);
		this._rateLogger.logRateLimit(options.context, result as any);
		return result;
	}
}

export class LoggingOctokit {
	constructor(public readonly api: Octokit, private _rateLogger: RateLogger) { };

	async call<T, U>(api: (T) => Promise<U>, args: T): Promise<U> {
		const result = api(args);
		this._rateLogger.logRestRateLimit((api as unknown as { endpoint: { DEFAULTS: { url: string } | undefined } | undefined }).endpoint?.DEFAULTS?.url, result as Promise<unknown> as Promise<RestResponse>);
		return result;
	}
}
