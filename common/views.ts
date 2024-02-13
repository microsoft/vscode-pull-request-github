/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAccount, ILabel, IMilestone, IProject, ITeam, MergeMethod, MergeMethodsAvailability } from '../src/github/interface';

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
	isDraftDefault: boolean;
	isDraft?: boolean;
	labels?: ILabel[];
	isDarkTheme?: boolean;

	validate?: boolean;
	showTitleValidationError?: boolean;
	createError?: string;

	autoMergeDefault: boolean;
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
	labels: ILabel[];
}

export interface CreatePullRequestNew {
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
	labels: ILabel[];
	projects: IProject[];
	assignees: IAccount[];
	reviewers: (IAccount | ITeam)[];
	milestone?: IMilestone;
}

// #region new create view

export interface CreateParamsNew {
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
	remoteCount?: number;
	compareRemote?: RemoteInfo;
	compareBranch?: string;
	isDraftDefault: boolean;
	isDraft?: boolean;
	labels?: ILabel[];
	projects?: IProject[];
	assignees?: IAccount[];
	reviewers?: (IAccount | ITeam)[];
	milestone?: IMilestone;
	isDarkTheme?: boolean;
	generateTitleAndDescriptionTitle: string | undefined;
	initializeWithGeneratedTitleAndDescription: boolean;

	validate?: boolean;
	showTitleValidationError?: boolean;
	createError?: string;

	autoMergeDefault: boolean;
	autoMerge?: boolean;
	autoMergeMethod?: MergeMethod;
	allowAutoMerge?: boolean;
	defaultMergeMethod?: MergeMethod;
	mergeMethodsAvailability?: MergeMethodsAvailability;
	baseHasMergeQueue: boolean;

	creating: boolean;
}

export interface ChooseRemoteAndBranchArgs {
	currentRemote: RemoteInfo | undefined;
	currentBranch: string | undefined;
}

export interface ChooseBaseRemoteAndBranchResult {
	baseRemote: RemoteInfo;
	baseBranch: string;
	defaultBaseBranch: string;
	defaultMergeMethod: MergeMethod;
	allowAutoMerge: boolean;
	mergeMethodsAvailability: MergeMethodsAvailability;
	autoMergeDefault: boolean;
	baseHasMergeQueue: boolean;
	defaultTitle: string;
	defaultDescription: string;
}

export interface ChooseCompareRemoteAndBranchResult {
	compareRemote: RemoteInfo;
	compareBranch: string;
	defaultCompareBranch: string;
}

export interface TitleAndDescriptionArgs {
	useCopilot: boolean;
}

export interface TitleAndDescriptionResult {
	title: string | undefined;
	description: string | undefined;
}

// #endregion