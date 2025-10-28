/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as React from 'react';

export const Icon = ({ className = '', src, title }: { className?: string; title?: string; src: string }) => (
	<span className={`icon ${className}`} title={title} dangerouslySetInnerHTML={{ __html: src }} />
);

export default Icon;
// Codicons
export const accountIcon = <Icon src={require('../../resources/icons/codicons/account.svg')} />;
export const addIcon = <Icon src={require('../../resources/icons/codicons/add.svg')} />;
export const checkIcon = <Icon src={require('../../resources/icons/codicons/check.svg')} className='check' />;
export const chevronDownIcon = <Icon src={require('../../resources/icons/codicons/chevron-down.svg')} />;
export const circleFilledIcon = <Icon src={require('../../resources/icons/codicons/circle-filled.svg')} className='pending' />;
export const closeIcon = <Icon src={require('../../resources/icons/codicons/close.svg')} className='close' />;
export const commentIcon = <Icon src={require('../../resources/icons/codicons/comment.svg')} />;
export const copilotIcon = <Icon src={require('../../resources/icons/codicons/copilot.svg')} />;
export const copyIcon = <Icon src={require('../../resources/icons/codicons/copy.svg')} />;
export const editIcon = <Icon src={require('../../resources/icons/codicons/edit.svg')} />;
export const errorIcon = <Icon src={require('../../resources/icons/codicons/error.svg')} />;
export const feedbackIcon = <Icon src={require('../../resources/icons/codicons/feedback.svg')} />;
export const gitCommitIcon = <Icon src={require('../../resources/icons/codicons/git-commit.svg')} />;
export const gitMergeIcon = <Icon src={require('../../resources/icons/codicons/git-merge.svg')} />;
export const gitPullRequestClosedIcon = <Icon src={require('../../resources/icons/codicons/git-pull-request-closed.svg')} />;
export const gitPullRequestDraftIcon = <Icon src={require('../../resources/icons/codicons/git-pull-request-draft.svg')} />;
export const gitPullRequestIcon = <Icon src={require('../../resources/icons/codicons/git-pull-request.svg')} />;
export const issuescon = <Icon src={require('../../resources/icons/codicons/issues.svg')} />;
export const loadingIcon = <Icon className='loading' src={require('../../resources/icons/codicons/loading.svg')} />;
export const milestoneIcon = <Icon src={require('../../resources/icons/codicons/milestone.svg')} />;
export const passIcon = <Icon src={require('../../resources/icons/codicons/pass.svg')} />;
export const projectIcon = <Icon src={require('../../resources/icons/codicons/github-project.svg')} />;
export const quoteIcon = <Icon src={require('../../resources/icons/codicons/quote.svg')} />;
export const requestChangesIcon = <Icon src={require('../../resources/icons/codicons/request-changes.svg')} />;
export const settingsIcon = <Icon src={require('../../resources/icons/codicons/settings-gear.svg')} />;
export const sparkleIcon = <Icon src={require('../../resources/icons/codicons/sparkle.svg')} />;
export const stopCircleIcon = <Icon src={require('../../resources/icons/codicons/stop-circle.svg')} />;
export const syncIcon = <Icon src={require('../../resources/icons/codicons/sync.svg')} />;
export const tagIcon = <Icon src={require('../../resources/icons/codicons/tag.svg')} />;
export const tasklistIcon = <Icon src={require('../../resources/icons/codicons/tasklist.svg')} />;
export const threeBars = <Icon src={require('../../resources/icons/codicons/three-bars.svg')} />;
export const trashIcon = <Icon src={require('../../resources/icons/codicons/trash.svg')} />;
export const warningIcon = <Icon src={require('../../resources/icons/codicons/warning.svg')} />;

// Other icons
export const copilotErrorIcon = <Icon className='copilot-icon' src={require('../../resources/icons/copilot-error.svg')} />;
export const copilotInProgressIcon = <Icon className='copilot-icon' src={require('../../resources/icons/copilot-in-progress.svg')} />;
export const copilotSuccessIcon = <Icon className='copilot-icon' src={require('../../resources/icons/copilot-success.svg')} />;
export const prMergeIcon = <Icon src={require('../../resources/icons/codicons/merge.svg')} />;
export const skipIcon = <Icon src={require('../../resources/icons/codicons/skip.svg')} className='skip' />;