/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useContext } from 'react';
import { gitHubLabelColor } from '../../src/common/utils';
import { IMilestone, IProject, IProjectItem, reviewerId } from '../../src/github/interface';
import { PullRequest } from '../../src/github/views';
import PullRequestContext from '../common/context';
import { Label } from '../common/label';
import { AuthorLink, Avatar } from '../components/user';
import { closeIcon, settingsIcon } from './icon';
import { Reviewer } from './reviewer';

export default function Sidebar({ reviewers, labels, hasWritePermission, isIssue, projectItems: projects, milestone, assignees }: PullRequest) {
	const {
		addReviewers,
		addAssignees,
		addAssigneeYourself,
		addLabels,
		removeLabel,
		changeProjects,
		addMilestone,
		updatePR,
		pr,
	} = useContext(PullRequestContext);

	const updateProjects = async () => {
		const newProjects = await changeProjects();
		updatePR({ ...newProjects });
	};

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
			<div id="project" className="section">
				<div className="section-header" onClick={updateProjects}>
					<div className="section-title">Project</div>
					{hasWritePermission ? (
						<button
							className="icon-button"
							title="Add Project">
							{settingsIcon}
						</button>
					) : null}
				</div>
				{!projects ?
					<a onClick={updateProjects}>Sign in with more permissions to see projects</a>
					: (projects.length > 0)
						? projects.map(project => (
							<Project key={project.project.title} {...project} canDelete={hasWritePermission} />
						)) :
						<div className="section-placeholder">None Yet</div>
				}
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
							updatePR({ milestone: undefined });
						}}
					>
						{closeIcon}️
					</button>
				) : null}
			</div>
		</div>
	);
}

function Project(project: IProjectItem & { canDelete: boolean }) {
	const { removeProject, updatePR, pr } = useContext(PullRequestContext);
	const backgroundBadgeColor = getComputedStyle(document.documentElement).getPropertyValue(
		'--vscode-badge-foreground',
	);
	const labelColor = gitHubLabelColor(backgroundBadgeColor, pr.isDarkTheme, false);
	const { canDelete } = project;
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
				{project.project.title}
				{canDelete ? (
					<button
						className="icon-button"
						onClick={async () => {
							await removeProject(project);
							updatePR({ projectItems: pr.projectItems?.filter(x => x.id !== project.id) });
						}}
					>
						{closeIcon}️
					</button>
				) : null}
			</div>
		</div>
	);
}
