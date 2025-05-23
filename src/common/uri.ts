/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { Buffer } from 'buffer';
import * as pathUtils from 'path';
import fetch from 'cross-fetch';
import * as vscode from 'vscode';
import { Repository } from '../api/api';
import { EXTENSION_ID } from '../constants';
import { IAccount, ITeam, reviewerId } from '../github/interface';
import { PullRequestModel } from '../github/pullRequestModel';
import { GitChangeType } from './file';
import Logger from './logger';
import { TemporaryState } from './temporaryState';
import { compareIgnoreCase } from './utils';

export interface ReviewUriParams {
	path: string;
	ref?: string;
	commit?: string;
	base: boolean;
	isOutdated: boolean;
	rootPath: string;
}

export function fromReviewUri(query: string): ReviewUriParams {
	return JSON.parse(query);
}

export interface PRUriParams {
	baseCommit: string;
	headCommit: string;
	isBase: boolean;
	fileName: string;
	prNumber: number;
	status: GitChangeType;
	remoteName: string;
	previousFileName?: string;
}

export function fromPRUri(uri: vscode.Uri): PRUriParams | undefined {
	if (uri.query === '') {
		return undefined;
	}
	try {
		return JSON.parse(uri.query) as PRUriParams;
	} catch (e) { }
}

export interface PRNodeUriParams {
	prIdentifier: string
}

export function fromPRNodeUri(uri: vscode.Uri): PRNodeUriParams | undefined {
	if (uri.query === '') {
		return undefined;
	}
	try {
		return JSON.parse(uri.query) as PRNodeUriParams;
	} catch (e) { }
}

export interface GitHubUriParams {
	fileName: string;
	branch: string;
	owner?: string;
	isEmpty?: boolean;
}
export function fromGitHubURI(uri: vscode.Uri): GitHubUriParams | undefined {
	if (uri.query === '') {
		return undefined;
	}
	try {
		return JSON.parse(uri.query) as GitHubUriParams;
	} catch (e) { }
}

export function toGitHubUri(fileUri: vscode.Uri, scheme: Schemes.GithubPr | Schemes.GitPr, params: GitHubUriParams): vscode.Uri {
	return fileUri.with({
		scheme,
		query: JSON.stringify(params)
	});
}

export interface GitUriOptions {
	replaceFileExtension?: boolean;
	submoduleOf?: string;
	base: boolean;
}

const ImageMimetypes = ['image/png', 'image/gif', 'image/jpeg', 'image/webp', 'image/tiff', 'image/bmp'];
// Known media types that VS Code can handle: https://github.com/microsoft/vscode/blob/a64e8e5673a44e5b9c2d493666bde684bd5a135c/src/vs/base/common/mime.ts#L33-L84
export const KnownMediaExtensions = [
	'.aac',
	'.avi',
	'.bmp',
	'.flv',
	'.gif',
	'.ico',
	'.jpe',
	'.jpeg',
	'.jpg',
	'.m1v',
	'.m2a',
	'.m2v',
	'.m3a',
	'.mid',
	'.midi',
	'.mk3d',
	'.mks',
	'.mkv',
	'.mov',
	'.movie',
	'.mp2',
	'.mp2a',
	'.mp3',
	'.mp4',
	'.mp4a',
	'.mp4v',
	'.mpe',
	'.mpeg',
	'.mpg',
	'.mpg4',
	'.mpga',
	'.oga',
	'.ogg',
	'.opus',
	'.ogv',
	'.png',
	'.psd',
	'.qt',
	'.spx',
	'.svg',
	'.tga',
	'.tif',
	'.tiff',
	'.wav',
	'.webm',
	'.webp',
	'.wma',
	'.wmv',
	'.woff'
];

// a 1x1 pixel transparent gif, from http://png-pixel.com/
export const EMPTY_IMAGE_URI = vscode.Uri.parse(
	`data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==`,
);

export async function asTempStorageURI(uri: vscode.Uri, repository: Repository): Promise<vscode.Uri | undefined> {
	try {
		const { commit, baseCommit, headCommit, isBase, path }: { commit: string, baseCommit: string, headCommit: string, isBase: string, path: string } = JSON.parse(uri.query);
		const ext = pathUtils.extname(path);
		if (!KnownMediaExtensions.includes(ext)) {
			return;
		}
		const ref = uri.scheme === Schemes.Review ? commit : isBase ? baseCommit : headCommit;

		const absolutePath = pathUtils.join(repository.rootUri.fsPath, path).replace(/\\/g, '/');
		const { object } = await repository.getObjectDetails(ref, absolutePath);
		const { mimetype } = await repository.detectObjectType(object);

		if (mimetype === 'text/plain') {
			return;
		}

		if (ImageMimetypes.indexOf(mimetype) > -1) {
			const contents = await repository.buffer(ref, absolutePath);
			return TemporaryState.write(pathUtils.dirname(path), pathUtils.basename(path), contents);
		}
	} catch (err) {
		return;
	}
}

export namespace DataUri {
	const iconsFolder = 'userIcons';

	function iconFilename(user: IAccount | ITeam): string {
		return `${reviewerId(user)}.jpg`;
	}

	function cacheLocation(context: vscode.ExtensionContext): vscode.Uri {
		return vscode.Uri.joinPath(context.globalStorageUri, iconsFolder);
	}

	function fileCacheUri(context: vscode.ExtensionContext, user: IAccount | ITeam): vscode.Uri {
		return vscode.Uri.joinPath(cacheLocation(context), iconFilename(user));
	}

	function cacheLogUri(context: vscode.ExtensionContext): vscode.Uri {
		return vscode.Uri.joinPath(cacheLocation(context), 'cache.log');
	}

	async function writeAvatarToCache(context: vscode.ExtensionContext, user: IAccount | ITeam, contents: Uint8Array): Promise<vscode.Uri> {
		await vscode.workspace.fs.createDirectory(cacheLocation(context));
		const file = fileCacheUri(context, user);
		await vscode.workspace.fs.writeFile(file, contents);
		return file;
	}

	async function readAvatarFromCache(context: vscode.ExtensionContext, user: IAccount | ITeam): Promise<Uint8Array | undefined> {
		try {
			const file = fileCacheUri(context, user);
			return vscode.workspace.fs.readFile(file);
		} catch (e) {
			return;
		}
	}

	export function asImageDataURI(contents: Buffer): vscode.Uri {
		return vscode.Uri.parse(
			`data:image/svg+xml;size:${contents.byteLength};base64,${contents.toString('base64')}`
		);
	}

	export async function avatarCirclesAsImageDataUris(context: vscode.ExtensionContext, users: (IAccount | ITeam)[], height: number, width: number, localOnly?: boolean): Promise<(vscode.Uri | undefined)[]> {
		let cacheLogOrder: string[];
		const cacheLog = cacheLogUri(context);
		try {
			const log = await vscode.workspace.fs.readFile(cacheLog);
			cacheLogOrder = JSON.parse(log.toString());
		} catch (e) {
			cacheLogOrder = [];
		}
		const startingCacheSize = cacheLogOrder.length;

		const results = await Promise.all(users.map(async (user) => {

			const imageSourceUrl = user.avatarUrl;
			if (imageSourceUrl === undefined) {
				return undefined;
			}
			let innerImageContents: Buffer | undefined;
			let cacheMiss: boolean = false;
			try {
				const fileContents = await readAvatarFromCache(context, user);
				if (!fileContents) {
					throw new Error('Temporary state not initialized');
				}
				innerImageContents = Buffer.from(fileContents);
			} catch (e) {
				if (localOnly) {
					return;
				}
				cacheMiss = true;
				const doFetch = async () => {
					const response = await fetch(imageSourceUrl.toString());
					const buffer = await response.arrayBuffer();
					await writeAvatarToCache(context, user, new Uint8Array(buffer));
					innerImageContents = Buffer.from(buffer);
				};
				try {
					await doFetch();
				} catch (e) {
					// We retry once.
					await doFetch();
				}
			}
			if (!innerImageContents) {
				return undefined;
			}
			if (cacheMiss) {
				const icon = iconFilename(user);
				cacheLogOrder.push(icon);
			}
			const innerImageEncoded = `data:image/jpeg;size:${innerImageContents.byteLength};base64,${innerImageContents.toString('base64')}`;
			const contentsString = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
		<image href="${innerImageEncoded}" width="${width}" height="${height}" style="clip-path: inset(0 0 0 0 round 50%);"/>
		</svg>`;
			const contents = Buffer.from(contentsString);
			const finalDataUri = asImageDataURI(contents);
			return finalDataUri;
		}));

		const maxCacheSize = Math.max(users.length, 200);
		if (cacheLogOrder.length > startingCacheSize && startingCacheSize > 0 && cacheLogOrder.length > maxCacheSize) {
			// The cache is getting big, we should clean it up.
			const toDelete = cacheLogOrder.splice(0, 50);
			await Promise.all(toDelete.map(async (id) => {
				try {
					await vscode.workspace.fs.delete(vscode.Uri.joinPath(cacheLocation(context), id));
				} catch (e) {
					Logger.error(`Failed to delete avatar from cache: ${e}`, 'avatarCirclesAsImageDataUris');
				}
			}));
		}

		await vscode.workspace.fs.writeFile(cacheLog, Buffer.from(JSON.stringify(cacheLogOrder)));

		return results;
	}
}

export function toReviewUri(
	uri: vscode.Uri,
	filePath: string | undefined,
	ref: string | undefined,
	commit: string,
	isOutdated: boolean,
	options: GitUriOptions,
	rootUri: vscode.Uri,
): vscode.Uri {
	const params: ReviewUriParams = {
		path: filePath ? filePath : uri.path,
		ref,
		commit: commit,
		base: options.base,
		isOutdated,
		rootPath: rootUri.path,
	};

	let path = uri.path;

	if (options.replaceFileExtension) {
		path = `${path}.git`;
	}

	return uri.with({
		scheme: Schemes.Review,
		path,
		query: JSON.stringify(params),
	});
}

export interface FileChangeNodeUriParams {
	prNumber: number;
	fileName: string;
	previousFileName?: string;
	status?: GitChangeType;
}

export function toResourceUri(uri: vscode.Uri, prNumber: number, fileName: string, status: GitChangeType, previousFileName?: string) {
	const params: FileChangeNodeUriParams = {
		prNumber,
		fileName,
		status,
		previousFileName
	};

	return uri.with({
		scheme: Schemes.FileChange,
		query: JSON.stringify(params),
	});
}

export function fromFileChangeNodeUri(uri: vscode.Uri): FileChangeNodeUriParams | undefined {
	if (uri.query === '') {
		return undefined;
	}
	try {
		return JSON.parse(uri.query) as FileChangeNodeUriParams;
	} catch (e) { }
}

export function toPRUri(
	uri: vscode.Uri,
	pullRequestModel: PullRequestModel,
	baseCommit: string,
	headCommit: string,
	fileName: string,
	base: boolean,
	status: GitChangeType,
	previousFileName?: string
): vscode.Uri {
	const params: PRUriParams = {
		baseCommit: baseCommit,
		headCommit: headCommit,
		isBase: base,
		fileName: fileName,
		prNumber: pullRequestModel.number,
		status: status,
		remoteName: pullRequestModel.githubRepository.remote.remoteName,
		previousFileName
	};

	const path = uri.path;

	return uri.with({
		scheme: Schemes.Pr,
		path,
		query: JSON.stringify(params),
	});
}

export function createPRNodeIdentifier(pullRequest: PullRequestModel | { remote: string, prNumber: number } | string) {
	let identifier: string;
	if (pullRequest instanceof PullRequestModel) {
		identifier = `${pullRequest.remote.url}:${pullRequest.number}`;
	} else if (typeof pullRequest === 'string') {
		identifier = pullRequest;
	} else {
		identifier = `${pullRequest.remote}:${pullRequest.prNumber}`;
	}
	return identifier;
}

export function createPRNodeUri(
	pullRequest: PullRequestModel | { remote: string, prNumber: number } | string
): vscode.Uri {
	const identifier = createPRNodeIdentifier(pullRequest);
	const params: PRNodeUriParams = {
		prIdentifier: identifier,
	};

	const uri = vscode.Uri.parse(`PRNode:${identifier}`);

	return uri.with({
		scheme: Schemes.PRNode,
		query: JSON.stringify(params)
	});
}

export interface NotificationUriParams {
	key: string;
}

export function toNotificationUri(params: NotificationUriParams) {
	return vscode.Uri.from({ scheme: Schemes.Notification, path: params.key });
}

export function fromNotificationUri(uri: vscode.Uri): NotificationUriParams | undefined {
	if (uri.scheme !== Schemes.Notification) {
		return;
	}
	try {
		return {
			key: uri.path,
		};
	} catch (e) { }
}


interface IssueFileQuery {
	origin: string;
}

export interface NewIssueUriParams {
	originUri: vscode.Uri;
	repoUriParams?: RepoUriParams;
}

interface RepoUriQuery {
	folderManagerRootUri: string;
}

export function toNewIssueUri(params: NewIssueUriParams) {
	const query: IssueFileQuery = {
		origin: params.originUri.toString()
	};
	if (params.repoUriParams) {
		query.origin = toRepoUri(params.repoUriParams).toString();
	}
	return vscode.Uri.from({ scheme: Schemes.NewIssue, path: '/NewIssue.md', query: JSON.stringify(query) });
}

export function fromNewIssueUri(uri: vscode.Uri): NewIssueUriParams | undefined {
	if (uri.scheme !== Schemes.NewIssue) {
		return;
	}
	try {
		const query = JSON.parse(uri.query);
		const originUri = vscode.Uri.parse(query.origin);
		const repoUri = fromRepoUri(originUri);
		return {
			originUri,
			repoUriParams: repoUri
		};
	} catch (e) { }
}

export interface RepoUriParams {
	owner: string;
	repo: string;
	repoRootUri: vscode.Uri;
}

function toRepoUri(params: RepoUriParams) {
	const repoQuery: RepoUriQuery = {
		folderManagerRootUri: params.repoRootUri.toString()
	};
	return vscode.Uri.from({ scheme: Schemes.Repo, path: `${params.owner}/${params.repo}`, query: JSON.stringify(repoQuery) });
}

export function fromRepoUri(uri: vscode.Uri): RepoUriParams | undefined {
	if (uri.scheme !== Schemes.Repo) {
		return;
	}
	const [owner, repo] = uri.path.split('/');
	try {
		const query = JSON.parse(uri.query);
		const repoRootUri = vscode.Uri.parse(query.folderManagerRootUri);
		return {
			owner,
			repo,
			repoRootUri
		};
	} catch (e) { }
}

export enum UriHandlerPaths {
	OpenIssueWebview = '/open-issue-webview',
	OpenPullRequestWebview = '/open-pull-request-webview',
}

export interface OpenIssueWebviewUriParams {
	owner: string;
	repo: string;
	issueNumber: number;
}

export async function toOpenIssueWebviewUri(params: OpenIssueWebviewUriParams): Promise<vscode.Uri> {
	const query = JSON.stringify(params);
	return vscode.env.asExternalUri(vscode.Uri.from({ scheme: vscode.env.uriScheme, authority: EXTENSION_ID, path: UriHandlerPaths.OpenIssueWebview, query }));
}

export function fromOpenIssueWebviewUri(uri: vscode.Uri): OpenIssueWebviewUriParams | undefined {
	if (compareIgnoreCase(uri.authority, EXTENSION_ID) !== 0) {
		return;
	}
	if (uri.path !== UriHandlerPaths.OpenIssueWebview) {
		return;
	}
	try {
		const query = JSON.parse(uri.query.split('&')[0]);
		if (!query.owner || !query.repo || !query.issueNumber) {
			return;
		}
		return query;
	} catch (e) { }
}

export interface OpenPullRequestWebviewUriParams {
	owner: string;
	repo: string;
	pullRequestNumber: number;
}

export async function toOpenPullRequestWebviewUri(params: OpenPullRequestWebviewUriParams): Promise<vscode.Uri> {
	const query = JSON.stringify(params);
	return vscode.env.asExternalUri(vscode.Uri.from({ scheme: vscode.env.uriScheme, authority: EXTENSION_ID, path: UriHandlerPaths.OpenPullRequestWebview, query }));
}

export function fromOpenPullRequestWebviewUri(uri: vscode.Uri): OpenPullRequestWebviewUriParams | undefined {
	if (compareIgnoreCase(uri.authority, EXTENSION_ID) !== 0) {
		return;
	}
	if (uri.path !== UriHandlerPaths.OpenPullRequestWebview) {
		return;
	}
	try {
		const query = JSON.parse(uri.query.split('&')[0]);
		if (!query.owner || !query.repo || !query.pullRequestNumber) {
			return;
		}
		return query;
	} catch (e) { }
}

export enum Schemes {
	File = 'file',
	Review = 'review', // File content for a checked out PR
	Pr = 'pr', // File content from GitHub for non-checkout PR
	PRNode = 'prnode',
	FileChange = 'filechange', // Tree items, for decorations
	GithubPr = 'githubpr', // File content from GitHub in create flow
	GitPr = 'gitpr', // File content from git in create flow
	VscodeVfs = 'vscode-vfs', // Remote Repository
	Comment = 'comment', // Comments from the VS Code comment widget
	MergeOutput = 'merge-output', // Merge output
	Notification = 'notification', // Notification tree items in the notification view
	NewIssue = 'newissue', // New issue file
	Repo = 'repo', // New issue file for passing data
	Git = 'git', // File content from the git extension
}

export function resolvePath(from: vscode.Uri, to: string) {
	if (from.scheme === Schemes.File) {
		return pathUtils.resolve(from.fsPath, to);
	} else {
		return pathUtils.posix.resolve(from.path, to);
	}
}
