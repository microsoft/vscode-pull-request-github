/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import * as pathUtils from 'path';
import { EventEmitter, Uri, UriHandler } from 'vscode';
import { Repository } from '../api/api';
import { PullRequestModel as AzdoPullRequestModel } from '../azdo/pullRequestModel';
import { URI_SCHEME_PR, URI_SCHEME_RESOURCE, URI_SCHEME_REVIEW } from '../constants';
import { GitChangeType } from './file';

export interface ReviewUriParams {
	path: string;
	ref?: string;
	commit?: string;
	base: boolean;
	isOutdated: boolean;
	rootPath: string;
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
	remoteName: string;
}

export function fromPRUri(uri: Uri): PRUriParams | undefined {
	try {
		return JSON.parse(uri.query) as PRUriParams;
	} catch (e) {}
}

export interface GitUriOptions {
	replaceFileExtension?: boolean;
	submoduleOf?: string;
	base: boolean;
}

const ImageMimetypes = ['image/png', 'image/gif', 'image/jpeg', 'image/webp', 'image/tiff', 'image/bmp'];

// a 1x1 pixel transparent gif, from http://png-pixel.com/
export const EMPTY_IMAGE_URI = Uri.parse(`data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==`);

export async function asImageDataURI(uri: Uri, repository: Repository): Promise<Uri | undefined> {
	try {
		const { commit, baseCommit, headCommit, isBase } = JSON.parse(uri.query);
		const ref = uri.scheme === URI_SCHEME_REVIEW ? commit : isBase ? baseCommit : headCommit;
		const { size, object } = await repository.getObjectDetails(ref, uri.fsPath);
		const { mimetype } = await repository.detectObjectType(object);

		if (mimetype === 'text/plain') {
			return;
		}

		if (ImageMimetypes.indexOf(mimetype) > -1) {
			const contents = await repository.buffer(ref, uri.fsPath);
			return Uri.parse(
				`data:${mimetype};label:${pathUtils.basename(
					uri.fsPath,
				)};description:${ref};size:${size};base64,${contents.toString('base64')}`,
			);
		}
	} catch (err) {
		return;
	}
}

export function toReviewUri(
	uri: Uri,
	filePath: string | undefined,
	ref: string | undefined,
	commit: string,
	isOutdated: boolean,
	options: GitUriOptions,
	rootUri: Uri,
): Uri {
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
		scheme: URI_SCHEME_REVIEW,
		path,
		query: JSON.stringify(params),
	});
}

export interface FileChangeNodeUriParams {
	prNumber: number;
	fileName: string;
	status?: GitChangeType;
}

export function toResourceUri(uri: Uri, prNumber: number, fileName: string, status: GitChangeType) {
	const params = {
		prNumber: prNumber,
		fileName: fileName,
		status: status,
	};

	return uri.with({
		scheme: URI_SCHEME_RESOURCE,
		query: JSON.stringify(params),
	});
}

export function fromFileChangeNodeUri(uri: Uri): FileChangeNodeUriParams | undefined {
	try {
		return JSON.parse(uri.query) as FileChangeNodeUriParams;
	} catch (e) {}
}

export function toPRUriAzdo(
	uri: Uri,
	pullRequestModel: AzdoPullRequestModel,
	baseCommit: string,
	headCommit: string,
	fileName: string,
	base: boolean,
	status: GitChangeType,
): Uri {
	const params: PRUriParams = {
		baseCommit: baseCommit,
		headCommit: headCommit,
		isBase: base,
		fileName: fileName,
		prNumber: pullRequestModel.getPullRequestId(),
		status: status,
		remoteName: pullRequestModel.azdoRepository.remote.remoteName,
	};

	const path = uri.path;

	return uri.with({
		scheme: URI_SCHEME_PR,
		path,
		query: JSON.stringify(params),
	});
}

class UriEventHandler extends EventEmitter<Uri> implements UriHandler {
	public handleUri(uri: Uri) {
		this.fire(uri);
	}
}

export const handler = new UriEventHandler();
