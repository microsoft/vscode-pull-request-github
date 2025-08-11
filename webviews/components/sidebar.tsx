/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useContext, useRef, useState } from 'react';
import { COPILOT_LOGINS } from '../../src/common/copilot';
import { gitHubLabelColor } from '../../src/common/utils';
import { IMilestone, IProjectItem, reviewerId } from '../../src/github/interface';
import { PullRequest } from '../../src/github/views';
import PullRequestContext from '../common/context';
import { Label } from '../common/label';
import { AuthorLink, Avatar } from '../components/user';
import { chevronRightIcon, closeIcon, copilotIcon, settingsIcon } from './icon';
import { Reviewer } from './reviewer';

export default function Sidebar({ reviewers, labels, hasWritePermission, isIssue, projectItems: projects, milestone, assignees, canAssignCopilot }: PullRequest) {
	const {
		addReviewers,
		addAssignees,
		addAssigneeYourself,
		addAssigneeCopilot,
		addLabels,
		removeLabel,
		changeProjects,
		addMilestone,
		updatePR,
		pr,
	} = useContext(PullRequestContext);

	const [assigningCopilot, setAssigningCopilot] = useState(false);

	const shouldShowCopilotButton = canAssignCopilot && assignees.every(assignee => !COPILOT_LOGINS.includes(assignee.login));

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
							<Reviewer key={reviewerId(state.reviewer)} {...{ reviewState: state }} />
						))
					) : (
						<div className="section-placeholder">None yet</div>
					)}
				</div>
			) : (
				''
			)}
			<div id="assignees" className="section">
				<div
					className="section-header"
					onClick={async (e) => {
						// Only prevent if the "Assign to Copilot" button is clicked (by id)
						const target = e.target as HTMLElement;
						if (target.closest('#assign-copilot-btn')) {
							return;
						}
						const newAssignees = await addAssignees();
						updatePR({ assignees: newAssignees.assignees, events: newAssignees.events });
					}}
				>
					<div className="section-title">Assignees</div>
					{hasWritePermission ?
						(<div className="icon-button-group">
							{shouldShowCopilotButton ? (
								<button
									id="assign-copilot-btn"
									className="icon-button"
									title="Assign for Copilot to work on"
									disabled={assigningCopilot}
									onClick={async () => {
										setAssigningCopilot(true);
										try {
											const newAssignees = await addAssigneeCopilot();
											updatePR({ assignees: newAssignees.assignees, events: newAssignees.events });
										} finally {
											setAssigningCopilot(false);
										}
									}}>
									{copilotIcon}
								</button>
							) : null}
							<button
								className="icon-button"
								title="Add Assignees">
								{settingsIcon}
							</button>
						</div>) : null}
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
						{pr!.hasWritePermission ? (
							<>
								&mdash;
								<a
									className="assign-yourself"
									onClick={async () => {
										const newAssignees = await addAssigneeYourself();
										updatePR({ assignees: newAssignees.assignees, events: newAssignees.events });
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
							<Label key={label.name} {...label} canDelete={hasWritePermission} isDarkTheme={pr!.isDarkTheme}>
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
			{pr!.isEnterprise ? null :
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
							<div className="section-placeholder">None yet</div>
					}
				</div>
			}
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

export function CollapsibleSidebar(props: PullRequest) {
	const [expanded, setExpanded] = useState(true);
	const contentRef = useRef<HTMLDivElement>(null);

	return (
		<div className="collapsible-sidebar">
			<div
				className="collapsible-sidebar-header"
				onClick={() => setExpanded(e => !e)}
				tabIndex={0}
				role="button"
				aria-expanded={expanded}
			>
				<span
					className={`collapsible-sidebar-twistie${expanded ? ' expanded' : ''}`}
					aria-hidden="true"
				>
					{chevronRightIcon}
				</span>
				<span className="collapsible-sidebar-title">Sidebar</span>
			</div>
			<div
				className="collapsible-sidebar-content"
				ref={contentRef}
				style={{ display: expanded ? 'block' : 'none' }}
			>
				<Sidebar {...props} />
			</div>
		</div>
	);
}

function Milestone(milestone: IMilestone & { canDelete: boolean }) {
	const { removeMilestone, updatePR, pr } = useContext(PullRequestContext);
	const backgroundBadgeColor = getComputedStyle(document.documentElement).getPropertyValue(
		'--vscode-badge-foreground',
	);
	const labelColor = gitHubLabelColor(backgroundBadgeColor, pr!.isDarkTheme, false);
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
	const labelColor = gitHubLabelColor(backgroundBadgeColor, pr!.isDarkTheme, false);
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
							updatePR({ projectItems: pr!.projectItems?.filter(x => x.id !== project.id) });
						}}
					>
						{closeIcon}️
					</button>
				) : null}
			</div>
		</div>
	);
}
