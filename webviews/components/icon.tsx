/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as React from 'react';

export const Icon = ({ className = '', src, title }: { className?: string; title?: string; src: string }) => (
	<span className={`icon ${className}`} title={title} dangerouslySetInnerHTML={{ __html: src }} />
);

export default Icon;

export const warningIcon = <Icon src={require('../../resources/icons/warning.svg')} />;
export const checkIcon = <Icon src={require('../../resources/icons/check.svg')} className='check' />;
export const skipIcon = <Icon src={require('../../resources/icons/skip.svg')} className='skip' />;
export const chevronDownIcon = <Icon src={require('../../resources/icons/chevron-down.svg')} />;
export const commentIcon = <Icon src={require('../../resources/icons/comment.svg')} />;
export const quoteIcon = <Icon src={require('../../resources/icons/quote.svg')} />;
export const gitCommitIcon = <Icon src={require('../../resources/icons/git-commit.svg')} />;
export const copyIcon = <Icon src={require('../../resources/icons/copy.svg')} />;
export const trashIcon = <Icon src={require('../../resources/icons/trash.svg')} />;
export const gitMergeIcon = <Icon src={require('../../resources/icons/git-merge.svg')} />;
export const gitPullRequestClosedIcon = <Icon src={require('../../resources/icons/git-pull-request-closed.svg')} />;
export const gitPullRequestIcon = <Icon src={require('../../resources/icons/git-pull-request.svg')} />;
export const gitPullRequestDraftIcon = <Icon src={require('../../resources/icons/git-pull-request-draft.svg')} />;
export const editIcon = <Icon src={require('../../resources/icons/edit.svg')} />;
export const addIcon = <Icon src={require('../../resources/icons/add.svg')} />;
export const dotIcon = <Icon src={require('../../resources/icons/circle-filled.svg')} className='pending' />;
export const requestChanges = <Icon src={require('../../resources/icons/request-changes.svg')} />;
export const settingsIcon = <Icon src={require('../../resources/icons/settings-gear.svg')} />;
export const closeIcon = <Icon src={require('../../resources/icons/close.svg')} className='close' />;
export const syncIcon = <Icon src={require('../../resources/icons/sync.svg')} />;
export const gitCompareIcon = <Icon src={require('../../resources/icons/git-compare.svg')} />;
export const prMergeIcon = <Icon src={require('../../resources/icons/pr_merge.svg')} />;
export const accountIcon = <Icon src={require('../../resources/icons/account.svg')} />;
export const feedbackIcon = <Icon src={require('../../resources/icons/feedback.svg')} />;
export const tagIcon = <Icon src={require('../../resources/icons/tag.svg')} />;
export const milestoneIcon = <Icon src={require('../../resources/icons/milestone.svg')} />;
export const projectIcon = <Icon src={require('../../resources/icons/github-project.svg')} />;
export const sparkleIcon = <Icon src={require('../../resources/icons/sparkle.svg')} />;
export const stopCircleIcon = <Icon src={require('../../resources/icons/stop-circle.svg')} />;
export const issueIcon = <Icon src={require('../../resources/icons/issue.svg')} />;
export const passIcon = <Icon src={require('../../resources/icons/pass.svg')} />;
export const copilotIcon = <Icon src={require('../../resources/icons/copilot.svg')} />;
export const threeBars = <Icon src={require('../../resources/icons/three-bars.svg')} />;
export const tasklistIcon = <Icon src={require('../../resources/icons/tasklist.svg')} />;
export const errorIcon = <Icon src={require('../../resources/icons/error.svg')} />;
export const loadingIcon = <Icon className='loading' src={require('../../resources/icons/loading.svg')} />;
export const copilotSuccessIcon = <Icon className='copilot-icon' src={require('../../resources/icons/copilot-success.svg')} />;
export const copilotErrorIcon = <Icon className='copilot-icon' src={require('../../resources/icons/copilot-error.svg')} />;
export const copilotInProgressIcon = <Icon className='copilot-icon' src={require('../../resources/icons/copilot-in-progress.svg')} />;
