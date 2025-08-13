/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useContext, useRef, useState } from 'react';
import { COPILOT_LOGINS } from '../../src/common/copilot';
import { gitHubLabelColor } from '../../src/common/utils';
import { IAccount, IMilestone, IProjectItem, reviewerId, reviewerLabel, ReviewState } from '../../src/github/interface';
import { PullRequest } from '../../src/github/views';
import PullRequestContext from '../common/context';
import { Label } from '../common/label';
import { AuthorLink, Avatar } from '../components/user';
import { chevronRightIcon, closeIcon, copilotIcon, settingsIcon } from './icon';
import { Reviewer } from './reviewer';

function Section({
	id,
	title,
	hasWritePermission,
	onHeaderClick,
	children,
	iconButtonGroup,
}: {
	id: string,
	title: string,
	hasWritePermission: boolean,
	onHeaderClick?: (e?: React.MouseEvent) => void | Promise<void>,
	children: React.ReactNode,
	iconButtonGroup?: React.ReactNode,
}) {
	return (
		<div id={id} className="section">
			<div
				className="section-header"
				onClick={onHeaderClick}
			>
				<div className="section-title">{title}</div>
				{hasWritePermission ? (
					iconButtonGroup ? iconButtonGroup : (
						<button
							className="icon-button"
							title={`Add ${title}`}
							onClick={onHeaderClick}
						>
							{settingsIcon}
						</button>
					)
				) : null}
			</div>
			{children}
		</div>
	);
}

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
			{!isIssue && (
				<Section
					id="reviewers"
					title="Reviewers"
					hasWritePermission={hasWritePermission}
					onHeaderClick={async () => {
						const newReviewers = await addReviewers();
						updatePR({ reviewers: newReviewers.reviewers });
					}}
				>
					{reviewers && reviewers.length ? (
						reviewers.map(state => (
							<Reviewer key={reviewerId(state.reviewer)} {...{ reviewState: state }} />
						))
					) : (
						<div className="section-placeholder">None yet</div>
					)}
				</Section>
			)}

			<Section
				id="assignees"
				title="Assignees"
				hasWritePermission={hasWritePermission}
				onHeaderClick={async (e) => {
					const target = e?.target as HTMLElement;
					if (target?.closest && target.closest('#assign-copilot-btn')) {
						return;
					}
					const newAssignees = await addAssignees();
					updatePR({ assignees: newAssignees.assignees, events: newAssignees.events });
				}}
				iconButtonGroup={hasWritePermission && (
					<div className="icon-button-group">
						{shouldShowCopilotButton ? (
							<button
								id="assign-copilot-btn"
								className="icon-button"
								title="Assign for Copilot to work on"
								disabled={assigningCopilot}
								onClick={async (e) => {
									e.stopPropagation();
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
							title="Add Assignees"
						>
							{settingsIcon}
						</button>
					</div>
				)}
			>
				{assignees && assignees.length ? (
					assignees.map((x, i) => (
						<div key={i} className="section-item reviewer">
							<div className="avatar-with-author">
								<Avatar for={x} />
								<AuthorLink for={x} />
							</div>
						</div>
					))
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
			</Section>

			<Section
				id="labels"
				title="Labels"
				hasWritePermission={hasWritePermission}
				onHeaderClick={async () => {
					const newLabels = await addLabels();
					updatePR({ labels: newLabels.added });
				}}
			>
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
			</Section>

			{!pr!.isEnterprise && (
				<Section
					id="project"
					title="Project"
					hasWritePermission={hasWritePermission}
					onHeaderClick={updateProjects}
				>
					{!projects ?
						<a onClick={updateProjects}>Sign in with more permissions to see projects</a>
						: (projects.length > 0)
							? projects.map(project => (
								<Project key={project.project.title} {...project} canDelete={hasWritePermission} />
							)) :
							<div className="section-placeholder">None yet</div>
					}
				</Section>
			)}

			<Section
				id="milestone"
				title="Milestone"
				hasWritePermission={hasWritePermission}
				onHeaderClick={async () => {
					const newMilestone = await addMilestone();
					updatePR({ milestone: newMilestone.added });
				}}
			>
				{milestone ? (
					<Milestone key={milestone.title} {...milestone} canDelete={hasWritePermission} />
				) : (
					<div className="section-placeholder">No milestone</div>
				)}
			</Section>
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
				<span className="collapsible-sidebar-title">{expanded ? null : <CollapsedLabel {...props} />}</span>
			</div>
			<div
				className="collapsible-sidebar-content"
				ref={contentRef}
				style={{ display: expanded ? 'block' : 'none' }}
			>
				<Sidebar {...props} />
			</div>
			<a className='collapsible-label-see-more' onClick={() => setExpanded(e => !e)}>{expanded ? 'See less' : 'See more...'}</a>
		</div>
	);
}

function CollapsedLabel(props: PullRequest) {
	const { reviewers, assignees, labels, projectItems, milestone, isIssue } = props;

	// Helper to render avatar stack
	const AvatarStack = ({ users }: { users: { avatarUrl: string; name: string }[] }) => (
		<span className="avatar-stack" style={{
			width: `${Math.min(users.length, 10) * 10 + 10}px`
		}}>
			{users.slice(0, 10).map((u, i) => (
				<span className='stacked-avatar' style={{
					left: `${i * 10}px`,
				}}>
					<Avatar for={u} />
				</span>
			))}
		</span>
	);

	// Helper to render label/project/milestone stack
	const PillStack = ({ items, getKey, getColor, getText }: {
		items: any[],
		getKey: (item: any) => string,
		getColor: (item: any) => { backgroundColor: string; textColor: string; borderColor: string },
		getText: (item: any) => string
	}) => {
		return <span className="pill-stack">
			{items.slice(0, 5).map((item, i) => {
				const color = getColor(item);
				const pill = (
					<span
						key={getKey(item)}
						className="stacked-pill"
						style={{
							backgroundColor: color.backgroundColor,
							color: color.textColor,
							borderRadius: '20px',
							left: `${(i * 20)}px`,
						}}
						title={getText(item)}
					>
						{getText(item)}
					</span>
				);
				return pill;
			})}
		</span>;

	};

	// Collect non-empty sections in order, with custom rendering
	const sections: { label: string; value: React.ReactNode }[] = [];

	const reviewersWithAvatar = reviewers?.filter((r): r is ReviewState & { reviewer: { avatarUrl: string } } => !!r.reviewer.avatarUrl).map(r => ({ avatarUrl: r.reviewer.avatarUrl, name: reviewerLabel(r.reviewer) }));
	if (!isIssue && reviewersWithAvatar && reviewersWithAvatar.length) {
		sections.push({
			label: 'Reviewers',
			value: <AvatarStack users={reviewersWithAvatar} />
		});
	}

	const assigneesWithAvatar = assignees?.filter((a): a is IAccount & { avatarUrl: string; login: string } => !!a.avatarUrl).map(a => ({ avatarUrl: a.avatarUrl, name: reviewerLabel(a) }));
	if (assigneesWithAvatar && assigneesWithAvatar.length) {
		sections.push({
			label: 'Assignees',
			value: <AvatarStack users={assigneesWithAvatar} />
		});
	}
	if (labels && labels.length) {
		sections.push({
			label: 'Labels',
			value: (
				<PillStack
					items={labels}
					getKey={l => l.name}
					getColor={l => gitHubLabelColor(l.color, props?.isDarkTheme, false)}
					getText={l => l.name}
				/>
			)
		});
	}
	if (projectItems && projectItems.length) {
		sections.push({
			label: 'Project',
			value: (
				<PillStack
					items={projectItems}
					getKey={p => p.project.title}
					getColor={() => gitHubLabelColor('#ededed', props?.isDarkTheme, false)}
					getText={p => p.project.title}
				/>
			)
		});
	}
	if (milestone) {
		sections.push({
			label: 'Milestone',
			value: (
				<PillStack
					items={[milestone]}
					getKey={m => m.title}
					getColor={() => gitHubLabelColor('#ededed', props?.isDarkTheme, false)}
					getText={m => m.title}
				/>
			)
		});
	}

	if (!sections.length) {
		return <span className="collapsed-label">{isIssue ? 'Assignees, Labels, Project, and Milestone' : 'Reviewers, Assignees, Labels, Project, and Milestone'}</span>;
	}

	return (
		<span className="collapsed-label">
			{sections.map((s, i) => (
				<span className='collapsed-section' key={s.label}>
					{s.label} {s.value}
					{i < sections.length - 1 ? ' ' : ''}
				</span>
			))}
		</span>
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
