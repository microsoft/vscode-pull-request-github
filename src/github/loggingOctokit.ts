/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Octokit } from '@octokit/rest';
import { ApolloClient, ApolloQueryResult, FetchResult, MutationOptions, NormalizedCacheObject, OperationVariables, QueryOptions } from 'apollo-boost';
import * as vscode from 'vscode';
import Logger from '../common/logger';
import { RateLimit } from './graphql';

const RATE_COUNTER_LAST_WINDOW = 'rateCounterLastWindow';
const RATE_COUNTER_COUNT = 'rateCounterCount';

interface RestResponse {
	headers: {
		'x-ratelimit-limit': string;
		'x-ratelimit-remaining': string;
	}
}

export class RateLogger {
	private lastWindow: number;
	private count: number = 0;
	private static ID = 'RateLimit';

	constructor(private readonly context: vscode.ExtensionContext) {
		// We assume the common case for this logging: only one user.
		// We also make up our own window. This will not line up exactly with GitHub's rate limit reset time,
		// but it will give us a nice idea of how many API calls we're making. We use an hour, just like GitHub.
		this.lastWindow = this.context.globalState.get(RATE_COUNTER_LAST_WINDOW, 0);
		// It looks like there might be separate rate limits for the REST and GraphQL api.
		// We'll just count total API calls as a lower bound.
		this.count = this.context.globalState.get(RATE_COUNTER_COUNT, 0);
		this.tryUpdateWindow();
	}

	private tryUpdateWindow() {
		const now = new Date().getTime();
		if ((now - this.lastWindow) > (60 * 60 * 1000) /* 1 hour */) {
			this.lastWindow = now;
			this.context.globalState.update(RATE_COUNTER_LAST_WINDOW, this.lastWindow);
			this.count = 0;
		}
	}

	public log(info: string | undefined) {
		this.tryUpdateWindow();
		this.count++;
		this.context.globalState.update(RATE_COUNTER_COUNT, this.count);
		const countMessage = `API call count: ${this.count}${info ? ` (${info})` : ''}`;
		if (this.count > 4000) {
			Logger.appendLine(countMessage, RateLogger.ID);
		} else {
			Logger.debug(countMessage, RateLogger.ID);
		}
	}

	public async logGraphqlRateLimit(result: Promise<{ data: { rateLimit: RateLimit | undefined } | undefined } | undefined>) {
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
		const remaining = `Rate limit remaining: ${rateLimitInfo?.remaining}`;
		if ((rateLimitInfo?.remaining ?? 1000) < 1000) {
			Logger.appendLine(remaining, RateLogger.ID);
		} else {
			Logger.debug(remaining, RateLogger.ID);
		}
	}

	public async logRestRateLimit(restResponse: Promise<RestResponse>) {
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
		this.logGraphqlRateLimit(Promise.resolve({ data: { rateLimit } }));
	}
}

export class LoggingApolloClient {
	constructor(private readonly _graphql: ApolloClient<NormalizedCacheObject>, private _rateLogger: RateLogger) { };

	query<T = any, TVariables = OperationVariables>(options: QueryOptions<TVariables>): Promise<ApolloQueryResult<T>> {
		this._rateLogger.log((options.query.definitions[0] as { name: { value: string } | undefined }).name?.value);
		const result = this._graphql.query(options);
		this._rateLogger.logGraphqlRateLimit(result as any);
		return result;
	}

	mutate<T = any, TVariables = OperationVariables>(options: MutationOptions<T, TVariables>): Promise<FetchResult<T>> {
		this._rateLogger.log(options.context);
		const result = this._graphql.mutate(options);
		this._rateLogger.logGraphqlRateLimit(result as any);
		return result;
	}
}

export class LoggingOctokit {
	constructor(public readonly api: Octokit, private _rateLogger: RateLogger) { };

	async call<T, U>(api: (T) => Promise<U>, args: T): Promise<U> {
		this._rateLogger.log((api as unknown as { endpoint: { DEFAULTS: { url: string } | undefined } | undefined }).endpoint?.DEFAULTS?.url);
		const result = api(args);
		this._rateLogger.logRestRateLimit(result as Promise<unknown> as Promise<RestResponse>);
		return result;
	}
}
