/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { Uri, UriHandler, EventEmitter } from 'vscode';
import { GitChangeType } from './file';
import { PullRequestModel } from '../github/pullRequestModel';

export interface ReviewUriParams {
	path: string;
	ref?: string;
	commit?: string;
	base: boolean;
	isOutdated: boolean;
}

export function fromReviewUri(uri: Uri): ReviewUriParams {
	return JSON.parse(uri.query);
}

export interface PRUriParams {
	baseCommit: string;
	headCommit: string;
	isBase: boolean;
	fileName: string;
	prNumber: number;
	status: GitChangeType;
}

export function fromPRUri(uri: Uri): PRUriParams {
	try {
		return JSON.parse(uri.query) as PRUriParams;
	} catch (e) {
		return null;
	}
}

export interface GitUriOptions {
	replaceFileExtension?: boolean;
	submoduleOf?: string;
	base: boolean;
}

// As a mitigation for extensions like ESLint showing warnings and errors
// for git URIs, let's change the file extension of these uris to .git,
// when `replaceFileExtension` is true.
export function toReviewUri(uri: Uri, filePath: string, ref: string, commit: string, isOutdated: boolean, options: GitUriOptions): Uri {
	const params: ReviewUriParams = {
		path: filePath ? filePath : uri.path,
		ref,
		commit: commit,
		base: options.base,
		isOutdated
	};

	let path = uri.path;

	if (options.replaceFileExtension) {
		path = `${path}.git`;
	}

	return uri.with({
		scheme: 'review',
		path,
		query: JSON.stringify(params)
	});
}

export interface FileChangeNodeUriParams {
	hasComments?: boolean;
	status?: GitChangeType;
}

export function toFileChangeNodeUri(uri: Uri, hasComments: boolean, status: GitChangeType) {
	const params = {
		hasComments: hasComments,
		status: status
	};

	return uri.with({
		scheme: 'file',
		query: JSON.stringify(params)
	});
}

export function fromFileChangeNodeUri(uri: Uri): FileChangeNodeUriParams {
	try {
		return JSON.parse(uri.query) as FileChangeNodeUriParams;
	} catch (e) {
		return null;
	}
}

export function toPRUri(uri: Uri, pullRequestModel: PullRequestModel, baseCommit: string, headCommit: string, fileName: string, base: boolean, status: GitChangeType): Uri {
	const params: PRUriParams = {
		baseCommit: baseCommit,
		headCommit: headCommit,
		isBase: base,
		fileName: fileName,
		prNumber: pullRequestModel.prNumber,
		status: status
	};

	let path = uri.path;

	return uri.with({
		scheme: 'pr',
		path,
		query: JSON.stringify(params)
	});
}

/**
 * Return the URI for the other side of a split view.
 *
 * @param uri this side of the split view (i.e. isBase=true)
 * @returns other side of the split view (i.e. isBase=false)
 */
export function otherPRUri(uri: Uri) {
	const params = fromPRUri(uri);
	const other = { ...params };
	other.isBase = !params.isBase;
	return uri.with({ query: JSON.stringify(other) });
}

class UriEventHandler extends EventEmitter<Uri> implements UriHandler {
	public handleUri(uri: Uri) {
		this.fire(uri);
	}
}

export const handler = new UriEventHandler;