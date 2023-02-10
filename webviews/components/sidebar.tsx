/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useContext } from 'react';
import { gitHubLabelColor } from '../../src/common/utils';
import { IMilestone, reviewerId } from '../../src/github/interface';
import { PullRequest } from '../common/cache';
import PullRequestContext from '../common/context';
import { Label } from '../common/label';
import { AuthorLink, Avatar } from '../components/user';
import { closeIcon, settingsIcon } from './icon';
import { Reviewer } from './reviewer';

export default function Sidebar({ reviewers, labels, hasWritePermission, isIssue, milestone, assignees }: PullRequest) {
	const {
		addReviewers,
		addAssignees,
		addAssigneeYourself,
		addLabels,
		removeLabel,
		addMilestone,
		updatePR,
		pr,
	} = useContext(PullRequestContext);
	return (
		<div id="sidebar">
			{!isIssue ? (
				<div id="reviewers" className="section">
					<div className="section-header" onClick={async () => {
						const newReviewers = await addReviewers();
						updatePR({ reviewers: newReviewers.reviewers });
					}}>
						<div className="section-title">Reviewers</div>
						{hasWritePermission ? (
							<button
								className="icon-button"
								title="Add Reviewers">
								{settingsIcon}
							</button>
						) : null}
					</div>
					{reviewers && reviewers.length ? (
						reviewers.map(state => (
							<Reviewer key={reviewerId(state.reviewer)} {...state} />
						))
					) : (
						<div className="section-placeholder">None yet</div>
					)}
				</div>
			) : (
				''
			)}
			<div id="assignees" className="section">
				<div className="section-header" onClick={async () => {
					const newAssignees = await addAssignees();
					updatePR({ assignees: newAssignees.assignees });
				}}>
					<div className="section-title">Assignees</div>
					{hasWritePermission ? (
						<button
							className="icon-button"
							title="Add Assignees">
							{settingsIcon}
						</button>
					) : null}
				</div>
				{assignees && assignees.length ? (
					assignees.map((x, i) => {
						return (
							<div key={i} className="section-item reviewer">
								<div className="avatar-with-author">
									<Avatar for={x} />
									<AuthorLink for={x} />
								</div>
							</div>
						);
					})
				) : (
					<div className="section-placeholder">
						None yet
						{pr.hasWritePermission ? (
							<>
								&mdash;
								<a
									className="assign-yourself"
									onClick={async () => {
										const newAssignees = await addAssigneeYourself();
										updatePR({ assignees: newAssignees.assignees });
									}}
								>
									assign yourself
								</a>
							</>
						) : null}
					</div>
				)}
			</div>

			<div id="labels" className="section">
				<div className="section-header" onClick={async () => {
					const newLabels = await addLabels();
					updatePR({ labels: newLabels.added });
				}}>
					<div className="section-title">Labels</div>
					{hasWritePermission ? (
						<button
							className="icon-button"
							title="Add Labels">
							{settingsIcon}
						</button>
					) : null}
				</div>
				{labels.length ? (
					<div className="labels-list">
						{labels.map(label => (
							<Label key={label.name} {...label} canDelete={hasWritePermission} isDarkTheme={pr.isDarkTheme}>
								{hasWritePermission ? (
									<button className="icon-button" onClick={() => removeLabel(label.name)}>
										{closeIcon}️
									</button>
								) : null}
							</Label>
						))}
					</div>
				) : (
					<div className="section-placeholder">None yet</div>
				)}
			</div>
			<div id="milestone" className="section">
				<div className="section-header" onClick={async () => {
					const newMilestone = await addMilestone();
					updatePR({ milestone: newMilestone.added });
				}}>
					<div className="section-title">Milestone</div>
					{hasWritePermission ? (
						<button
							className="icon-button"
							title="Add Milestone">
							{settingsIcon}
						</button>
					) : null}
				</div>
				{milestone ? (
					<Milestone key={milestone.title} {...milestone} canDelete={hasWritePermission} />
				) : (
					<div className="section-placeholder">No milestone</div>
				)}
			</div>
		</div>
	);
}

function Milestone(milestone: IMilestone & { canDelete: boolean }) {
	const { removeMilestone, updatePR, pr } = useContext(PullRequestContext);
	const backgroundBadgeColor = getComputedStyle(document.documentElement).getPropertyValue(
		'--vscode-badge-foreground',
	);
	const labelColor = gitHubLabelColor(backgroundBadgeColor, pr.isDarkTheme, false);
	const { canDelete, title } = milestone;
	return (
		<div className="labels-list">
			<div
				className="section-item label"
				style={{
					backgroundColor: labelColor.backgroundColor,
					color: labelColor.textColor,
					borderColor: `${labelColor.borderColor}`,
				}}
			>
				{title}
				{canDelete ? (
					<button
						className="icon-button"
						onClick={async () => {
							await removeMilestone();
							updatePR({ milestone: null });
						}}
					>
						{closeIcon}️
					</button>
				) : null}
			</div>
		</div>
	);
}
