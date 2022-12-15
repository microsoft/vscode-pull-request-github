/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { MergeMethod, MergeMethodsAvailability } from '../src/github/interface';

export interface RemoteInfo {
	owner: string;
	repositoryName: string;
}

export interface CreateParams {
	availableBaseRemotes: RemoteInfo[];
	availableCompareRemotes: RemoteInfo[];
	branchesForRemote: string[];
	branchesForCompare: string[];

	defaultBaseRemote?: RemoteInfo;
	defaultBaseBranch?: string;
	defaultCompareRemote?: RemoteInfo;
	defaultCompareBranch?: string;
	defaultTitle?: string;
	defaultDescription?: string;

	pendingTitle?: string;
	pendingDescription?: string;
	baseRemote?: RemoteInfo;
	baseBranch?: string;
	compareRemote?: RemoteInfo;
	compareBranch?: string;
	isDraft?: boolean;

	validate?: boolean;
	showTitleValidationError?: boolean;
	createError?: string;

	autoMerge?: boolean;
	autoMergeMethod?: MergeMethod;
	allowAutoMerge?: boolean;
	defaultMergeMethod?: MergeMethod;
	mergeMethodsAvailability?: MergeMethodsAvailability;
}

export interface ScrollPosition {
	x: number;
	y: number;
}

export interface CreatePullRequest {
	title: string;
	body: string;
	owner: string;
	repo: string;
	base: string
	compareBranch: string;
	compareOwner: string;
	compareRepo: string;
	draft: boolean;
	autoMerge: boolean;
	autoMergeMethod?: MergeMethod;
}