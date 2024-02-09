/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Octokit } from '@octokit/rest';
import { ApolloClient, ApolloQueryResult, FetchResult, MutationOptions, NormalizedCacheObject, OperationVariables, QueryOptions } from 'apollo-boost';
import { bulkhead, BulkheadPolicy } from 'cockatiel';
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
	private bulkhead: BulkheadPolicy = bulkhead(140);
	private static ID = 'RateLimit';
	private hasLoggedLowRateLimit: boolean = false;

	constructor(private readonly telemetry: ITelemetry, private readonly errorOnFlood: boolean) { }

	public logAndLimit(info: string | undefined, apiRequest: () => Promise<any>): Promise<any> | undefined {
		if (this.bulkhead.executionSlots === 0) {
			Logger.error('API call count has exceeded 140 concurrent calls.', RateLogger.ID);
			// We have hit more than 140 concurrent API requests.
			/* __GDPR__
				"pr.highApiCallRate" : {}
			*/
			this.telemetry.sendTelemetryErrorEvent('pr.highApiCallRate');

			if (!this.errorOnFlood) {
				// We don't want to error on flood, so try to execute the API request anyway.
				return apiRequest();
			} else {
				vscode.window.showErrorMessage(vscode.l10n.t('The GitHub Pull Requests extension is making too many requests to GitHub. This indicates a bug in the extension. Please file an issue on GitHub and include the output from "GitHub Pull Request".'));
				return undefined;
			}
		}
		const log = `Extension rate limit remaining: ${this.bulkhead.executionSlots}, ${info}`;
		if (this.bulkhead.executionSlots < 5) {
			Logger.appendLine(log, RateLogger.ID);
		} else {
			Logger.debug(log, RateLogger.ID);
		}

		return this.bulkhead.execute(() => apiRequest());
	}

	public async logRateLimit(info: string | undefined, result: Promise<{ data: { rateLimit: RateLimit | undefined } | undefined } | undefined>, isRest: boolean = false) {
		let rateLimitInfo: { limit: number, remaining: number, cost: number } | undefined;
		try {
			const resolvedResult = await result;
			rateLimitInfo = resolvedResult?.data?.rateLimit;
		} catch (e) {
			// Ignore errors here since we're just trying to log the rate limit.
			return;
		}
		const isSearch = info?.startsWith('/search/');
		if ((rateLimitInfo?.limit ?? 5000) < 5000) {
			if (!isSearch) {
				Logger.appendLine(`Unexpectedly low rate limit: ${rateLimitInfo?.limit}`, RateLogger.ID);
			} else if ((rateLimitInfo?.limit ?? 30) < 30) {
				Logger.appendLine(`Unexpectedly low SEARCH rate limit: ${rateLimitInfo?.limit}`, RateLogger.ID);
			}
		}
		const remaining = `${isRest ? 'REST' : 'GraphQL'} Rate limit remaining: ${rateLimitInfo?.remaining}, cost: ${rateLimitInfo?.cost}, ${info}`;
		if (((rateLimitInfo?.remaining ?? 1000) < 1000) && !isSearch) {
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
	constructor(private readonly _graphql: ApolloClient<NormalizedCacheObject>, private _rateLogger: RateLogger) { }

	query<T = any, TVariables = OperationVariables>(options: QueryOptions<TVariables>): Promise<ApolloQueryResult<T>> {
		const logInfo = (options.query.definitions[0] as { name: { value: string } | undefined }).name?.value;
		const result = this._rateLogger.logAndLimit(logInfo, () => this._graphql.query(options));
		if (result === undefined) {
			throw new Error('API call count has exceeded a rate limit.');
		}
		this._rateLogger.logRateLimit(logInfo, result as any);
		return result;
	}

	mutate<T = any, TVariables = OperationVariables>(options: MutationOptions<T, TVariables>): Promise<FetchResult<T>> {
		const logInfo = options.context;
		const result = this._rateLogger.logAndLimit(logInfo, () => this._graphql.mutate(options));
		if (result === undefined) {
			throw new Error('API call count has exceeded a rate limit.');
		}
		this._rateLogger.logRateLimit(logInfo, result as any);
		return result;
	}
}

export class LoggingOctokit {
	constructor(public readonly api: Octokit, private _rateLogger: RateLogger) { }

	async call<T, U>(api: (T) => Promise<U>, args: T): Promise<U> {
		const logInfo = (api as unknown as { endpoint: { DEFAULTS: { url: string } | undefined } | undefined }).endpoint?.DEFAULTS?.url;
		const result = this._rateLogger.logAndLimit(logInfo, () => api(args));
		if (result === undefined) {
			throw new Error('API call count has exceeded a rate limit.');
		}
		this._rateLogger.logRestRateLimit(logInfo, result as Promise<unknown> as Promise<RestResponse>);
		return result;
	}
}
