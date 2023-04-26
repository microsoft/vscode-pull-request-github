/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as crypto from 'crypto';
import { RequestError } from '@octokit/request-error';
import { OctokitResponse, RequestParameters, ResponseHeaders } from '@octokit/types';
import PQueue from 'p-queue';
import * as vscode from 'vscode';
import Logger from '../common/logger';
import { DEFAULT_GRAVATAR_STYLE, PR_SETTINGS_NAMESPACE } from '../common/settingKeys';
import * as Common from '../common/timelineEvent';
import { IAccount, Issue, ITeam, PullRequest } from './interface';
import { LoggingOctokit } from './loggingOctokit';
import { getEnterpriseUri, hasEnterpriseUri } from './utils';

const GRAVATAR_STYLE_NONE = 'none';

function isGravatarEnabled() {
	return getGravatarStyle() !== GRAVATAR_STYLE_NONE;
}

function getGravatarStyle() {
	return vscode.workspace
		.getConfiguration(PR_SETTINGS_NAMESPACE)
		.get<string>(DEFAULT_GRAVATAR_STYLE, GRAVATAR_STYLE_NONE);
}

function generateGravatarUrl(gravatarId: string | undefined, size: number = 200): string | undefined {
	if (!gravatarId || !isGravatarEnabled()) {
		return undefined;
	}

	return `https://www.gravatar.com/avatar/${gravatarId}?s=${size}&d=${getGravatarStyle()}`;
}

function getExtensionFromType(type: string): string {
	switch (type) {
		case 'image/avif':
			return '.avif';
		case 'image/bmp':
			return '.bmp';
		case 'image/gif':
			return '.gif';
		case 'image/vnd.microsoft.icon':
			return '.ico';
		case 'image/jpeg':
			return '.jpg';
		case 'image/png':
			return '.png';
		case 'image/svg+xml':
			return '.svg';
		case 'image/tiff':
			return '.tif';
		case 'image/webp':
			return '.webp';
	}

	return '.bin';
}

interface CacheControl {
	'max-age'?: number;
	's-maxage'?: number;
	[directive: string]: string | number | undefined;
}

interface CacheResult {
	content?: Buffer;
	contentType?: string;
	uri?: vscode.Uri;
	isFresh: boolean;
	doWrite: boolean;
}

// This limits the concurrent promises that fetch avatars from the Enterprise REST service
const enterpriseAvatarQueue = new PQueue({ concurrency: 3 });

function convertBinaryToDataUri(data: Buffer, contentType: string) {
	return `data:${contentType};base64,${data.toString('base64')}`;
}

const LOGGER_COMPONENT = 'Avatars';
const ENTERPRISE_AVATAR_REST_BASE = '/enterprise/avatars';

export class Avatars {
	private baseUri: vscode.Uri;
	private rereadCache: boolean = true;
	private lastReadAuthority: string = '';
	private headersCache: { [k: string]: ResponseHeaders } = {};

	constructor(public context: vscode.ExtensionContext) {
		this.baseUri = vscode.Uri.joinPath(context.globalStorageUri, 'avatarCache');
	}

	private getCacheBase(authority: string) {
		return vscode.Uri.joinPath(this.baseUri, authority);
	}

	private getCacheMetaFile(authority: string) {
		return vscode.Uri.joinPath(this.getCacheBase(authority), '.meta.json');
	}

	private getCacheFile(authority: string, key: string, type: string) {
		return vscode.Uri.joinPath(this.getCacheBase(authority), `${key}${getExtensionFromType(type)}`);
	}

	private async _reloadCache(authority: string) {
		if (this.lastReadAuthority !== authority) {
			this.rereadCache = true;
		}

		if (!this.rereadCache) {
			return;
		}

		await vscode.workspace.fs.createDirectory(this.getCacheBase(authority));
		const cacheMetaFile = this.getCacheMetaFile(authority);

		this.headersCache = {};

		try {
			const loadedCache = await vscode.workspace.fs.readFile(cacheMetaFile);
			this.headersCache = JSON.parse(loadedCache.toString()) || {};
			this.lastReadAuthority = authority;
			this.rereadCache = false;
		} catch (e) {
			Logger.debug(e, LOGGER_COMPONENT);
		}
	}

	private async checkCache(
		authority: string,
		key: string,
		name: string,
		options: RequestParameters,
	): Promise<CacheResult> {
		const result: CacheResult = {
			isFresh: false,
			doWrite: false,
		};

		if (!(key in this.headersCache)) {
			return result;
		}

		const headers = this.headersCache[key];
		result.contentType = headers['content-type'] || '';
		result.uri = this.getCacheFile(authority, name, result.contentType);

		try {
			result.content = Buffer.from(await vscode.workspace.fs.readFile(result.uri));

			const cacheControlDirectives: CacheControl = {};
			const cacheControl = (headers['cache-control'] || '').split(',');
			for (const directive of cacheControl) {
				let [name, param] = directive.split('=', 2);
				name = name.trim().toLowerCase();
				if (name === 'max-age' || name == 's-maxage') {
					const age = Number.parseInt(param, 10);
					cacheControlDirectives[name] = age;
				} else {
					cacheControlDirectives[name] = param;
				}
			}

			const serverDate = headers.date ? new Date(headers.date) : new Date();
			const expireAt = serverDate.setSeconds(
				serverDate.getSeconds() +
				(cacheControlDirectives['s-maxage'] ?? cacheControlDirectives['max-age'] ?? 0),
			);
			if (expireAt - Date.now() > 0) {
				Logger.appendLine('Cache fresh hit', LOGGER_COMPONENT);
				result.isFresh = true;
				return result;
			}

			Logger.appendLine('Cache stale hit', LOGGER_COMPONENT);

			options.headers = {};
			if (headers['last-modified']) {
				options.headers['if-modified-since'] = headers['last-modified'];
			}
			if (headers.etag) {
				options.headers['if-none-match'] = headers.etag;
			}
		} catch (e) {
			Logger.appendLine('Corrupt cache entry removed', LOGGER_COMPONENT);
			delete this.headersCache[key];
			result.doWrite = true;
		}

		return result;
	}

	public async clear() {
		await vscode.workspace.fs.delete(this.baseUri, { recursive: true });
		await vscode.workspace.fs.createDirectory(this.baseUri);
		this.rereadCache = true;
	}

	public async getEnterpriseAvatarUrl(
		avatarUrl: string | undefined,
		octokit: LoggingOctokit,
	): Promise<string | undefined> {
		try {
			if (!avatarUrl || !hasEnterpriseUri()) {
				return;
			}

			const avatarUri = vscode.Uri.parse(avatarUrl, true);
			const authority = avatarUri.authority;
			const enterpriseUri = getEnterpriseUri()!;

			// static asset from enterprise does not need authentication
			if (avatarUri.scheme === 'data' || authority === `assets.${enterpriseUri.authority}`) {
				return avatarUrl;
			}

			// only proxy avatars from the "avatars" sub-domain of Enterprise
			if (authority !== `avatars.${enterpriseUri.authority}`) {
				return;
			}

			const cacheKey = `${avatarUri.path}?${avatarUri.query}`;
			const cacheFileName = crypto.createHash('sha256').update(cacheKey).digest('hex');
			const options: RequestParameters = {};
			const qs = new URLSearchParams(avatarUri.query);
			qs.forEach((v, k) => {
				options[k] = v;
			});

			await this._reloadCache(authority);

			const cacheResult = await this.checkCache(authority, cacheKey, cacheFileName, options);
			if (cacheResult.isFresh) {
				return convertBinaryToDataUri(cacheResult.content!, cacheResult.contentType!);
			}

			const avatarDataUri = await enterpriseAvatarQueue.add(() =>
				octokit.api.request(`GET ${ENTERPRISE_AVATAR_REST_BASE}${avatarUri.path}`, options).then(
					async (resp: OctokitResponse<ArrayBuffer, number>) => {
						this.headersCache[cacheKey] = resp.headers;
						cacheResult.doWrite = true;
						cacheResult.content = Buffer.from(resp.data);
						cacheResult.contentType = resp.headers['content-type'] || '';
						cacheResult.uri = this.getCacheFile(authority, cacheFileName, cacheResult.contentType);
						await vscode.workspace.fs.writeFile(cacheResult.uri, cacheResult.content);
						return convertBinaryToDataUri(cacheResult.content, cacheResult.contentType);
					},
					(reason: RequestError) => {
						if (reason.status !== 304) {
							Logger.warn(`REST request failed: ${reason.message}`, LOGGER_COMPONENT);
							return;
						}

						Logger.appendLine('Stale cache entry refreshed', LOGGER_COMPONENT);
						for (const header of Object.keys(reason.headers)) {
							this.headersCache[cacheKey][header] = reason.headers[header];
						}
						cacheResult.doWrite = true;
						return convertBinaryToDataUri(cacheResult.content!, cacheResult.contentType!);
					},
				),
			);

			if (cacheResult.doWrite) {
				await vscode.workspace.fs.writeFile(
					this.getCacheMetaFile(authority),
					new TextEncoder().encode(JSON.stringify(this.headersCache)),
				);
			}

			if (avatarDataUri) {
				return avatarDataUri;
			}
		} catch (e) {
			Logger.debug(e, LOGGER_COMPONENT);
		}
	}

	public async replaceAvatarUrl(user: IAccount | ITeam, octokit: LoggingOctokit): Promise<void> {
		const origAvatarUrl = user.avatarUrl;
		user.avatarUrl = undefined;

		const enterpriseAvatarUrl = await this.getEnterpriseAvatarUrl(origAvatarUrl, octokit);
		if (enterpriseAvatarUrl) {
			user.avatarUrl = enterpriseAvatarUrl;
			return;
		}

		if (!('login' in user)) {
			return;
		}

		if (user.email === undefined && user.login) {
			try {
				const { data } = await octokit.call(octokit.api.users.getByUsername, {
					username: user.login,
				});

				user.email = data.email || undefined;
			} catch {
				// ignore
			}
		}

		if (!user.email) {
			return;
		}

		user.avatarUrl = generateGravatarUrl(
			crypto.createHash('md5').update(user.email.trim().toLowerCase()).digest('hex'),
		);
	}

	public replaceAccountAvatarUrls(pr: PullRequest, octokit: LoggingOctokit): Promise<void[]> {
		const promises: Promise<void>[] = [];
		promises.push(this.replaceAvatarUrl(pr.user, octokit));
		if (pr.assignees) {
			promises.push(...pr.assignees.map(user => this.replaceAvatarUrl(user, octokit)));
		}
		if (pr.suggestedReviewers) {
			promises.push(...pr.suggestedReviewers.map(user => this.replaceAvatarUrl(user, octokit)));
		}
		return Promise.all(promises);
	}

	public replaceTimelineEventAvatarUrls(events: Common.TimelineEvent[], octokit: LoggingOctokit): Promise<void[]> {
		const promises: Promise<void>[] = [];

		for (const event of events) {
			const type = event.event;
			switch (type) {
				case Common.EventType.Commented:
					const commentEvent = event as Common.CommentEvent;
					promises.push(this.replaceAvatarUrl(commentEvent.user, octokit));
					break;
				case Common.EventType.Reviewed:
					const reviewEvent = event as Common.ReviewEvent;
					promises.push(this.replaceAvatarUrl(reviewEvent.user, octokit));
					break;
				case Common.EventType.Committed:
					const commitEv = event as Common.CommitEvent;
					promises.push(this.replaceAvatarUrl(commitEv.author, octokit));
					break;
				case Common.EventType.Merged:
					const mergeEv = event as Common.MergedEvent;
					promises.push(this.replaceAvatarUrl(mergeEv.user, octokit));
					break;
				case Common.EventType.Assigned:
					const assignEv = event as Common.AssignEvent;
					promises.push(this.replaceAvatarUrl(assignEv.user, octokit));
					promises.push(this.replaceAvatarUrl(assignEv.actor, octokit));
					break;
				case Common.EventType.HeadRefDeleted:
					const deletedEv = event as Common.HeadRefDeleteEvent;
					promises.push(this.replaceAvatarUrl(deletedEv.actor, octokit));
					break;
			}
		}

		return Promise.all(promises);
	}

	public replaceIssuesAvatarUrls(issues: Issue[], octokit: LoggingOctokit): Promise<void[]> {
		const promises: Promise<void>[] = [];

		for (const issue of issues) {
			promises.push(this.replaceAvatarUrl(issue.user, octokit));
			if (issue.assignees) {
				promises.push(...issue.assignees.map(user => this.replaceAvatarUrl(user, octokit)));
			}
		}

		return Promise.all(promises);
	}
}
