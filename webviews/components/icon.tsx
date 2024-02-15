/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable import/order */
import * as React from 'react';

export const Icon = ({ className = '', src, title }: { className?: string; title?: string; src: string }) => (
	<span className={`icon ${className}`} title={title} dangerouslySetInnerHTML={{ __html: src }} />
);

export default Icon;

export const alertIcon = <Icon src={require('../../resources/icons/alert.svg')} />;
export const checkIcon = <Icon src={require('../../resources/icons/check.svg')} />;
export const skipIcon = <Icon src={require('../../resources/icons/skip.svg')} />;
export const chevronIcon = <Icon src={require('../../resources/icons/chevron.svg')} />;
export const chevronDownIcon = <Icon src={require('../../resources/icons/chevron_down.svg')} />;
export const commentIcon = <Icon src={require('../../resources/icons/comment.svg')} />;
export const commitIcon = <Icon src={require('../../resources/icons/commit_icon.svg')} />;
export const copyIcon = <Icon src={require('../../resources/icons/copy.svg')} />;
export const deleteIcon = <Icon src={require('../../resources/icons/delete.svg')} />;
export const mergeIcon = <Icon src={require('../../resources/icons/merge_icon.svg')} />;
export const mergeMethodIcon = <Icon src={require('../../resources/icons/merge_method.svg')} />;
export const prClosedIcon = <Icon src={require('../../resources/icons/pr_closed.svg')} />;
export const prOpenIcon = <Icon src={require('../../resources/icons/pr.svg')} />;
export const prDraftIcon = <Icon src={require('../../resources/icons/pr_draft.svg')} />;
export const editIcon = <Icon src={require('../../resources/icons/edit.svg')} />;
export const plusIcon = <Icon src={require('../../resources/icons/plus.svg')} />;
export const pendingIcon = <Icon src={require('../../resources/icons/dot.svg')} />;
export const requestChanges = <Icon src={require('../../resources/icons/request_changes.svg')} />;
export const settingsIcon = <Icon src={require('../../resources/icons/settings.svg')} />;
export const closeIcon = <Icon src={require('../../resources/icons/close.svg')} />;
export const syncIcon = <Icon src={require('../../resources/icons/sync.svg')} />;
export const prBaseIcon = <Icon src={require('../../resources/icons/pr_base.svg')} />;
export const prMergeIcon = <Icon src={require('../../resources/icons/pr_merge.svg')} />;
export const gearIcon = <Icon src={require('../../resources/icons/gear.svg')} />;
export const assigneeIcon = <Icon src={require('../../resources/icons/assignee.svg')} />;
export const reviewerIcon = <Icon src={require('../../resources/icons/reviewer.svg')} />;
export const labelIcon = <Icon src={require('../../resources/icons/label.svg')} />;
export const milestoneIcon = <Icon src={require('../../resources/icons/milestone.svg')} />;
export const projectIcon = <Icon src={require('../../resources/icons/github-project.svg')} />;
export const sparkleIcon = <Icon src={require('../../resources/icons/sparkle.svg')} />;
export const stopIcon = <Icon src={require('../../resources/icons/stop.svg')} />;
