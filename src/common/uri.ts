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
import { IAccount, isTeam, ITeam, reviewerId } from '../github/interface';
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

export interface GitHubCommitUriParams {
	commit: string;
	owner: string;
	repo: string;
}

export function fromGitHubCommitUri(uri: vscode.Uri): GitHubCommitUriParams | undefined {
	if (uri.scheme !== Schemes.GitHubCommit || uri.query === '') {
		return undefined;
	}
	try {
		return JSON.parse(uri.query) as GitHubCommitUriParams;
	} catch (e) { }
}

export function toGitHubCommitUri(fileName: string, params: GitHubCommitUriParams): vscode.Uri {
	return vscode.Uri.from({
		scheme: Schemes.GitHubCommit,
		path: `/${fileName}`,
		query: JSON.stringify(params)
	});
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

	export function copilotErrorAsImageDataURI(foreground: string, color: string): vscode.Uri {
		const svgContent = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M13.807 2.265C13.228 1.532 12.313 1.141 11.083 1.004C9.877 0.870002 8.821 1.038 8.139 1.769C8.09 1.822 8.043 1.877 8 1.933C7.957 1.877 7.91 1.822 7.861 1.769C7.179 1.038 6.123 0.870002 4.917 1.004C3.687 1.141 2.772 1.532 2.193 2.265C1.628 2.981 1.5 3.879 1.5 4.75C1.5 5.322 1.553 5.897 1.754 6.405L1.586 7.243L1.52 7.276C0.588 7.742 0 8.694 0 9.736V11C0 11.24 0.086 11.438 0.156 11.567C0.231 11.704 0.325 11.828 0.415 11.933C0.595 12.143 0.819 12.346 1.02 12.513C1.225 12.684 1.427 12.836 1.577 12.943C1.816 13.116 2.062 13.275 2.318 13.423C2.625 13.6 3.066 13.832 3.614 14.065C4.391 14.395 5.404 14.722 6.553 14.887C6.203 14.377 5.931 13.809 5.751 13.202C5.173 13.055 4.645 12.873 4.201 12.684C3.717 12.479 3.331 12.274 3.067 12.123L3.002 12.085V7.824L3.025 7.709C3.515 7.919 4.1 8 4.752 8C5.898 8 6.812 7.672 7.462 7.009C7.681 6.785 7.859 6.535 8.002 6.266C8.049 6.354 8.106 6.436 8.16 6.52C8.579 6.238 9.038 6.013 9.522 5.843C9.26 5.52 9.077 5.057 8.996 4.407C8.879 3.471 9.034 3.011 9.238 2.793C9.431 2.586 9.875 2.379 10.919 2.495C11.939 2.608 12.398 2.899 12.632 3.195C12.879 3.508 13.002 3.984 13.002 4.75C13.002 5.158 12.967 5.453 12.909 5.674C13.398 5.792 13.865 5.967 14.3 6.197C14.443 5.741 14.502 5.248 14.502 4.75C14.502 3.879 14.374 2.981 13.809 2.265H13.807ZM7.006 4.407C6.915 5.133 6.704 5.637 6.388 5.959C6.089 6.264 5.604 6.5 4.75 6.5C3.828 6.5 3.47 6.301 3.308 6.12C3.129 5.92 3 5.542 3 4.75C3 3.984 3.123 3.508 3.37 3.195C3.604 2.899 4.063 2.609 5.083 2.495C6.127 2.379 6.571 2.586 6.764 2.793C6.968 3.011 7.123 3.471 7.006 4.407Z" fill="${foreground}" />
<path d="M11.5 7C9.015 7 7 9.015 7 11.5C7 13.985 9.015 16 11.5 16C13.985 16 16 13.985 16 11.5C16 9.015 13.985 7 11.5 7ZM13.854 13.146L13.147 13.853L11.501 12.207L9.855 13.853L9.148 13.146L10.794 11.5L9.148 9.854L9.855 9.147L11.501 10.793L13.147 9.147L13.854 9.854L12.208 11.5L13.854 13.146Z" fill="${color}" />
</svg>`;
		const contents = Buffer.from(svgContent);
		return asImageDataURI(contents);
	}

	export function copilotInProgressAsImageDataURI(foreground: string, color: string): vscode.Uri {
		const svgContent = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M13.807 2.265C13.228 1.532 12.313 1.141 11.083 1.004C9.877 0.870002 8.821 1.038 8.139 1.769C8.09 1.822 8.043 1.877 8 1.933C7.957 1.877 7.91 1.822 7.861 1.769C7.179 1.038 6.123 0.870002 4.917 1.004C3.687 1.141 2.772 1.532 2.193 2.265C1.628 2.981 1.5 3.879 1.5 4.75C1.5 5.322 1.553 5.897 1.754 6.405L1.586 7.243L1.52 7.276C0.588 7.742 0 8.694 0 9.736V11C0 11.24 0.086 11.438 0.156 11.567C0.231 11.704 0.325 11.828 0.415 11.933C0.595 12.143 0.819 12.346 1.02 12.513C1.225 12.684 1.427 12.836 1.577 12.943C1.816 13.116 2.062 13.275 2.318 13.423C2.625 13.6 3.066 13.832 3.614 14.065C4.391 14.395 5.404 14.722 6.553 14.887C6.203 14.377 5.931 13.809 5.751 13.202C5.173 13.055 4.645 12.873 4.201 12.684C3.717 12.479 3.331 12.274 3.067 12.123L3.002 12.085V7.824L3.025 7.709C3.515 7.919 4.1 8 4.752 8C5.898 8 6.812 7.672 7.462 7.009C7.681 6.785 7.859 6.535 8.002 6.266C8.049 6.354 8.106 6.436 8.16 6.52C8.579 6.238 9.038 6.013 9.522 5.843C9.26 5.52 9.077 5.057 8.996 4.407C8.879 3.471 9.034 3.011 9.238 2.793C9.431 2.586 9.875 2.379 10.919 2.495C11.939 2.608 12.398 2.899 12.632 3.195C12.879 3.508 13.002 3.984 13.002 4.75C13.002 5.158 12.967 5.453 12.909 5.674C13.398 5.792 13.865 5.967 14.3 6.197C14.443 5.741 14.502 5.248 14.502 4.75C14.502 3.879 14.374 2.981 13.809 2.265H13.807ZM7.006 4.407C6.915 5.133 6.704 5.637 6.388 5.959C6.089 6.264 5.604 6.5 4.75 6.5C3.828 6.5 3.47 6.301 3.308 6.12C3.129 5.92 3 5.542 3 4.75C3 3.984 3.123 3.508 3.37 3.195C3.604 2.899 4.063 2.609 5.083 2.495C6.127 2.379 6.571 2.586 6.764 2.793C6.968 3.011 7.123 3.471 7.006 4.407Z" fill="${foreground}" />
<path d="M11.5 7C9.015 7 7 9.015 7 11.5C7 13.985 9.015 16 11.5 16C13.985 16 16 13.985 16 11.5C16 9.015 13.985 7 11.5 7ZM11.5 14.25C10.963 14.25 10.445 14.105 10 13.844V14.5H9V12.5L9.5 12H11.5V13H10.536C10.823 13.16 11.155 13.25 11.5 13.25C12.177 13.25 12.805 12.907 13.137 12.354L13.994 12.87C13.481 13.722 12.525 14.25 11.5 14.25ZM14 10.5L13.5 11H11.5V10H12.464C12.177 9.84 11.845 9.75 11.5 9.75C10.823 9.75 10.195 10.093 9.863 10.646L9.006 10.13C9.519 9.278 10.475 8.75 11.5 8.75C12.037 8.75 12.555 8.895 13 9.156V8.5H14V10.5Z" fill="${color}" />
</svg>`;
		const contents = Buffer.from(svgContent);
		return asImageDataURI(contents);
	}

	export function copilotSuccessAsImageDataURI(foreground: string, color: string): vscode.Uri {
		const svgContent = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M13.807 2.265C13.228 1.532 12.313 1.141 11.083 1.004C9.877 0.870002 8.821 1.038 8.139 1.769C8.09 1.822 8.043 1.877 8 1.933C7.957 1.877 7.91 1.822 7.861 1.769C7.179 1.038 6.123 0.870002 4.917 1.004C3.687 1.141 2.772 1.532 2.193 2.265C1.628 2.981 1.5 3.879 1.5 4.75C1.5 5.322 1.553 5.897 1.754 6.405L1.586 7.243L1.52 7.276C0.588 7.742 0 8.694 0 9.736V11C0 11.24 0.086 11.438 0.156 11.567C0.231 11.704 0.325 11.828 0.415 11.933C0.595 12.143 0.819 12.346 1.02 12.513C1.225 12.684 1.427 12.836 1.577 12.943C1.816 13.116 2.062 13.275 2.318 13.423C2.625 13.6 3.066 13.832 3.614 14.065C4.391 14.395 5.404 14.722 6.553 14.887C6.203 14.377 5.931 13.809 5.751 13.202C5.173 13.055 4.645 12.873 4.201 12.684C3.717 12.479 3.331 12.274 3.067 12.123L3.002 12.085V7.824L3.025 7.709C3.515 7.919 4.1 8 4.752 8C5.898 8 6.812 7.672 7.462 7.009C7.681 6.785 7.859 6.535 8.002 6.266C8.049 6.354 8.106 6.436 8.16 6.52C8.579 6.238 9.038 6.013 9.522 5.843C9.26 5.52 9.077 5.057 8.996 4.407C8.879 3.471 9.034 3.011 9.238 2.793C9.431 2.586 9.875 2.379 10.919 2.495C11.939 2.608 12.398 2.899 12.632 3.195C12.879 3.508 13.002 3.984 13.002 4.75C13.002 5.158 12.967 5.453 12.909 5.674C13.398 5.792 13.865 5.967 14.3 6.197C14.443 5.741 14.502 5.248 14.502 4.75C14.502 3.879 14.374 2.981 13.809 2.265H13.807ZM7.006 4.407C6.915 5.133 6.704 5.637 6.388 5.959C6.089 6.264 5.604 6.5 4.75 6.5C3.828 6.5 3.47 6.301 3.308 6.12C3.129 5.92 3 5.542 3 4.75C3 3.984 3.123 3.508 3.37 3.195C3.604 2.899 4.063 2.609 5.083 2.495C6.127 2.379 6.571 2.586 6.764 2.793C6.968 3.011 7.123 3.471 7.006 4.407Z" fill="${foreground}" />
<path d="M11.5 7C9.015 7 7 9.015 7 11.5C7 13.985 9.015 16 11.5 16C13.985 16 16 13.985 16 11.5C16 9.015 13.985 7 11.5 7ZM11.393 13.309L10.7 13.401L8.7 11.901L9.3 11.1L10.909 12.307L13.357 9.192L14.143 9.809L11.393 13.309Z" fill="${color}" />
</svg>`;
		const contents = Buffer.from(svgContent);
		return asImageDataURI(contents);
	}

	function genericUserIconAsImageDataURI(width: number, height: number): vscode.Uri {
		// The account icon
		const foreground = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark ? '#FFFFFF' : '#000000';
		const svgContent = `<svg width="${width}" height="${height}" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
<path d="M16 7.992C16 3.58 12.416 0 8 0S0 3.58 0 7.992c0 2.43 1.104 4.62 2.832 6.09.016.016.032.016.032.032.144.112.288.224.448.336.08.048.144.111.224.175A7.98 7.98 0 0 0 8.016 16a7.98 7.98 0 0 0 4.48-1.375c.08-.048.144-.111.224-.16.144-.111.304-.223.448-.335.016-.016.032-.016.032-.032 1.696-1.487 2.8-3.676 2.8-6.106zm-8 7.001c-1.504 0-2.88-.48-4.016-1.279.016-.128.048-.255.08-.383a4.17 4.17 0 0 1 .416-.991c.176-.304.384-.576.64-.816.24-.24.528-.463.816-.639.304-.176.624-.304.976-.4A4.15 4.15 0 0 1 8 10.342a4.185 4.185 0 0 1 2.928 1.166c.368.368.656.8.864 1.295.112.288.192.592.24.911A7.03 7.03 0 0 1 8 14.993zm-2.448-7.4a2.49 2.49 0 0 1-.208-1.024c0-.351.064-.703.208-1.023.144-.32.336-.607.576-.847.24-.24.528-.431.848-.575.32-.144.672-.208 1.024-.208.368 0 .704.064 1.024.208.32.144.608.336.848.575.24.24.432.528.576.847.144.32.208.672.208 1.023 0 .368-.064.704-.208 1.023a2.84 2.84 0 0 1-.576.848 2.84 2.84 0 0 1-.848.575 2.715 2.715 0 0 1-2.064 0 2.84 2.84 0 0 1-.848-.575 2.526 2.526 0 0 1-.56-.848zm7.424 5.306c0-.032-.016-.048-.016-.08a5.22 5.22 0 0 0-.688-1.406 4.883 4.883 0 0 0-1.088-1.135 5.207 5.207 0 0 0-1.04-.608 2.82 2.82 0 0 0 .464-.383 4.2 4.2 0 0 0 .624-.784 3.624 3.624 0 0 0 .528-1.934 3.71 3.71 0 0 0-.288-1.47 3.799 3.799 0 0 0-.816-1.199 3.845 3.845 0 0 0-1.2-.8 3.72 3.72 0 0 0-1.472-.287 3.72 3.72 0 0 0-1.472.288 3.631 3.631 0 0 0-1.2.815 3.84 3.84 0 0 0-.8 1.199 3.71 3.71 0 0 0-.288 1.47c0 .352.048.688.144 1.007.096.336.224.64.4.927.16.288.384.544.624.784.144.144.304.271.48.383a5.12 5.12 0 0 0-1.04.624c-.416.32-.784.703-1.088 1.119a4.999 4.999 0 0 0-.688 1.406c-.016.032-.016.064-.016.08C1.776 11.636.992 9.91.992 7.992.992 4.14 4.144.991 8 .991s7.008 3.149 7.008 7.001a6.96 6.96 0 0 1-2.032 4.907z" fill="${foreground}"/>
</svg>`;
		const contents = Buffer.from(svgContent);
		return asImageDataURI(contents);
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
					try {
						await doFetch();
					} catch (retryError) {
						// Log the error and return a generic user icon instead of crashing
						const userIdentifier = isTeam(user) ? `${user.org}/${user.slug}` : user.login || 'unknown';
						Logger.error(`Failed to fetch avatar after retry for user ${userIdentifier}: ${retryError}`, 'avatarCirclesAsImageDataUris');
						return genericUserIconAsImageDataURI(width, height);
					}
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

/**
 * @param fileName The repo relative path to the file
 */
export function reviewPath(fileName: string, commitSha: string) {
	return vscode.Uri.parse(pathUtils.posix.join(`commit~${commitSha.substr(0, 8)}`, fileName));
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

export function parsePRNodeIdentifier(identifier: string): { remote: string, prNumber: number } | undefined {
	const lastColon = identifier.lastIndexOf(':');
	if (lastColon === -1) {
		return undefined;
	}
	const remote = identifier.substring(0, lastColon);
	const prNumberStr = identifier.substring(lastColon + 1);
	const prNumber = Number(prNumberStr);
	if (!remote || isNaN(prNumber) || prNumber <= 0) {
		return undefined;
	}
	return { remote, prNumber };
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

const ownerRegex = /^(?!-)(?!.*--)[a-zA-Z0-9-]+(?<!-)$/;
const repoRegex = /^[a-zA-Z0-9_.-]+$/;

function validateOpenWebviewParams(owner?: string, repo?: string, number?: string): boolean {
	if (!owner || !repo || !number) {
		return false;
	}
	const asNumber = Number(number);
	if (isNaN(asNumber) || asNumber <= 0) {
		return false;
	}
	if (isNaN(Number(number))) {
		return false;
	}
	if (owner.length === 0 || repo.length === 0) {
		return false;
	}
	if (!ownerRegex.test(owner)) {
		return false;
	}
	if (!repoRegex.test(repo)) {
		return false;
	}
	return true;
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
		if (!validateOpenWebviewParams(query.owner, query.repo, query.issueNumber)) {
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
		if (!validateOpenWebviewParams(query.owner, query.repo, query.pullRequestNumber)) {
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
	PRQuery = 'prquery', // PR query tree item
	GitHubCommit = 'githubcommit' // file content from GitHub for a commit
}

export const COPILOT_QUERY = vscode.Uri.from({ scheme: Schemes.PRQuery, path: 'copilot' });

export function resolvePath(from: vscode.Uri, to: string) {
	if (from.scheme === Schemes.File) {
		return pathUtils.resolve(from.fsPath, to);
	} else {
		return pathUtils.posix.resolve(from.path, to);
	}
}
