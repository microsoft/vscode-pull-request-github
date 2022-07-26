/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useContext } from 'react';
import { ILabel } from '../../src/github/interface';
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
		addMilestone,
		addLabels,
		updatePR,
		removeAssignee,
		removeMilestone,
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
								<a onClick={async () => {
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
					<div className="section-item label">
						{milestone.title}
						{hasWritePermission ? (
							<>
								{nbsp}
								<button
									className="push-right remove-item"
									onClick={async () => {
										await removeMilestone();
										updatePR({ milestone: null });
									}}
								>
									{deleteIcon}️
								</button>
								{nbsp}
							</>
						) : null}
					</div>
				) : (
					<div className="section-placeholder">No milestone</div>
				)}
			</div>
		</div>
	);
}

function Label(label: ILabel & { canDelete: boolean }) {
	const { name, canDelete, color } = label;
	const { removeLabel, hexToRgb, rgbToHsl, hslToHex } = useContext(PullRequestContext);
	const rgbColor = hexToRgb(color);
	const hslColor = rgbToHsl(rgbColor.r, rgbColor.g, rgbColor.b);

	const lightnessThreshold = 0.6;
	const backgroundAlpha = 0.18;
	const borderAlpha = 0.3;

	const perceivedLightness = (rgbColor.r * 0.2126 + rgbColor.g * 0.7152 + rgbColor.b * 0.0722) / 255;
	const lightnessSwitch = Math.max(0, Math.min((perceivedLightness - lightnessThreshold) * -1000, 1));

	const lightenBy = (lightnessThreshold - perceivedLightness) * 100 * lightnessSwitch;
	const textColor = `#${hslToHex(hslColor.h, hslColor.s, hslColor.l + lightenBy)}`;
	const backgroundColor = `rgba(${rgbColor.r}, ${rgbColor.g}, ${rgbColor.b}, ${backgroundAlpha})`;
	const rgbBorder = hexToRgb(hslToHex(hslColor.h, hslColor.s, hslColor.l + lightenBy));
	const borderColor = `rgba(${rgbBorder.r}, ${rgbBorder.g}, ${rgbBorder.b}, ${borderAlpha})`;

	return (
		<div
			className="section-item label"
			style={{
				backgroundColor: backgroundColor,
				color: textColor,
				border: `1px solid ${borderColor}`
			}}
		>
			{name}
			{canDelete ? (
				<>
					{nbsp}
					<button className="push-right remove-item"
						onClick={() => removeLabel(name)}
						style={{ stroke: textColor }}
					>
						{deleteIcon}️
					</button>
					{nbsp}
				</>
			) : null}
		</div>
	);
}
