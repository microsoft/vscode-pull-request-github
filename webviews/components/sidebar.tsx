/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useContext } from 'react';
import { gitHubLabelColor } from '../../src/common/utils';
import { ILabel, IMilestone } from '../../src/github/interface';
import { PullRequest } from '../common/cache';
import PullRequestContext from '../common/context';
import { AuthorLink, Avatar } from '../components/user';
import { deleteIcon, plusIcon } from './icon';
import { Reviewer } from './reviewer';
import { nbsp } from './space';

export default function Sidebar({ reviewers, labels, hasWritePermission, isIssue, milestone, assignees }: PullRequest) {
	const {
		addReviewers,
		addAssignees,
		addAssigneeYourself,
		addLabels,
		addMilestone,
		updatePR,
		removeAssignee,
		pr,
	} = useContext(PullRequestContext);

	return (
		<div id="sidebar">
			{!isIssue ? (
				<div id="reviewers" className="section">
					<div className="section-header">
						<div className="section-title">Reviewers</div>
						{hasWritePermission ? (
							<button
								title="Add Reviewers"
								onClick={async () => {
									const newReviewers = await addReviewers();
									updatePR({ reviewers: pr.reviewers.concat(newReviewers.added) });
								}}
							>
								{plusIcon}
							</button>
						) : null}
					</div>
					{reviewers && reviewers.length ? (
						reviewers.map(state => (
							<Reviewer key={state.reviewer.login} {...state} canDelete={hasWritePermission} />
						))
					) : (
						<div className="section-placeholder">None yet</div>
					)}
				</div>
			) : (
				''
			)}
			<div id="assignees" className="section">
				<div className="section-header">
					<div className="section-title">Assignees</div>
					{hasWritePermission ? (
						<button
							title="Add Assignees"
							onClick={async () => {
								const newAssignees = await addAssignees();
								updatePR({ assignees: pr.assignees.concat(newAssignees.added) });
							}}
						>
							{plusIcon}
						</button>
					) : null}
				</div>
				{assignees && assignees.length ? (
					assignees.map((x, i) => {
						return (
							<div key={i} className="section-item reviewer">
								<Avatar for={x} />
								<AuthorLink for={x} />
								{hasWritePermission ? (
									<>
										{nbsp}
										<button
											className="push-right remove-item"
											onClick={async () => {
												await removeAssignee(x.login);
											}}
										>
											{deleteIcon}️
										</button>
										{nbsp}
									</>
								) : null}
							</div>
						);
					})
				) : (
					<div className="section-placeholder">
						None yet{pr.canEdit ? (
							<>
								&mdash;
								<a className='assign-yourself' onClick={async () => {
									const currentUser = await addAssigneeYourself();
									updatePR({ assignees: pr.assignees.concat(currentUser.added) });
								}}>assign yourself</a>
							</>)
							: null}
					</div>
				)}
			</div>

			<div id="labels" className="section">
				<div className="section-header">
					<div className="section-title">Labels</div>
					{hasWritePermission ? (
						<button
							title="Add Labels"
							onClick={async () => {
								const newLabels = await addLabels();
								updatePR({ labels: pr.labels.concat(newLabels.added) });
							}}
						>
							{plusIcon}
						</button>
					) : null}
				</div>
				{labels.length ? (
					labels.map(label => <Label key={label.name} {...label} canDelete={hasWritePermission} />)
				) : (
					<div className="section-placeholder">None yet</div>
				)}
			</div>
			<div id="milestone" className="section">
				<div className="section-header">
					<div className="section-title">Milestone</div>
					{hasWritePermission ? (
						<button
							title="Add Milestone"
							onClick={async () => {
								const newMilestone = await addMilestone();
								updatePR({ milestone: newMilestone.added });
							}}
						>
							{plusIcon}
						</button>
					) : null}
				</div>
				{milestone ? (
					<Milestone key={milestone.title} {...milestone} canDelete={hasWritePermission} />
				) : (
					<div className="section-placeholder">No milestone</div>
				)}
			</div>
		</div >
	);
}

function Label(label: ILabel & { canDelete: boolean }) {
	const { name, canDelete, color } = label;
	const { removeLabel, pr } = useContext(PullRequestContext);
	const labelColor = gitHubLabelColor(color, pr.isDarkTheme, false);
	return (
		<div
			className="section-item label"
			style={{
				backgroundColor: labelColor.backgroundColor,
				color: labelColor.textColor,
				borderColor: `${labelColor.borderColor}`
			}}
		>
			{name}
			{canDelete ? (
				<>
					{nbsp}
					<button className="push-right remove-item"
						onClick={() => removeLabel(name)}
						style={{ stroke: labelColor.textColor }}
					>
						{deleteIcon}️
					</button>
					{nbsp}
				</>
			) : null}
		</div>
	);
}

function Milestone(milestone: IMilestone & { canDelete: boolean }) {
	const { removeMilestone, updatePR, pr } = useContext(PullRequestContext);
	const backgroundBadgeColor = getComputedStyle(document.documentElement).getPropertyValue('--vscode-badge-foreground');
	const labelColor = gitHubLabelColor(backgroundBadgeColor, pr.isDarkTheme, false);
	const { canDelete, title } = milestone;
	return (
		<div
			className="section-item label"
			style={{
				backgroundColor: labelColor.backgroundColor,
				color: labelColor.textColor,
				borderColor: `${labelColor.borderColor}`
			}}
		>
			{title}
			{canDelete ? (
				<>
					{nbsp}
					<button
						className="push-right remove-item"
						onClick={async () => {
							await removeMilestone();
							updatePR({ milestone: null });
						}}
						style={{ stroke: labelColor.textColor }}
					>
						{deleteIcon}️
					</button>
					{nbsp}
				</>
			) : null}
		</div>
	);
}
