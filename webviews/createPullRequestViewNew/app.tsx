/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { render } from 'react-dom';
import { CreateParamsNew, RemoteInfo } from '../../common/views';
import { compareIgnoreCase } from '../../src/common/utils';
import PullRequestContextNew from '../common/createContextNew';
import { ErrorBoundary } from '../common/errorBoundary';
import { LabelCreate } from '../common/label';
import { AutoMerge } from '../components/automergeSelect';
import { closeIcon, gearIcon, prBaseIcon, prMergeIcon, chevronDownIcon } from '../components/icon';
import { assigneeIcon, reviewerIcon, labelIcon, milestoneIcon } from '../components/icon';


export const ChooseRemoteAndBranch = ({ onClick, defaultRemote, defaultBranch, isBase }:
	{ onClick: (remote?: RemoteInfo, branch?: string) => Promise<void>, defaultRemote: RemoteInfo | undefined, defaultBranch: string | undefined, isBase: boolean }) => {

	const defaultsLabel = (defaultRemote && defaultBranch) ? `${defaultRemote.owner}/${defaultBranch}` : '-';
	const title = isBase ? 'Base branch: ' + defaultsLabel : 'Branch to merge: ' + defaultsLabel;

	return <ErrorBoundary>
		<div className='flex'>
			<button title={title} aria-label={title} className='secondary' onClick={() => {
				onClick(defaultRemote, defaultBranch);
			}}>
				{defaultsLabel}
			</button>
		</div>
	</ErrorBoundary>;
};


export function main() {
	render(
		<Root>
			{(params: CreateParamsNew) => {
				const ctx = useContext(PullRequestContextNew);
				const [isBusy, setBusy] = useState(false);

				const titleInput = useRef<HTMLInputElement>();

				function updateTitle(title: string): void {
					if (params.validate) {
						ctx.updateState({ pendingTitle: title, showTitleValidationError: !title });
					} else {
						ctx.updateState({ pendingTitle: title });
					}
				}

				async function create(): Promise<void> {
					setBusy(true);
					const hasValidTitle = ctx.validate();
					if (!hasValidTitle) {
						titleInput.current?.focus();
					} else {
						await ctx.submit();
					}
					setBusy(false);
				}

				let isCreateable: boolean = true;
				if (ctx.createParams.baseRemote && ctx.createParams.compareRemote && ctx.createParams.baseBranch && ctx.createParams.compareBranch
					&& compareIgnoreCase(ctx.createParams.baseRemote?.owner, ctx.createParams.compareRemote?.owner) === 0
					&& compareIgnoreCase(ctx.createParams.baseRemote?.repositoryName, ctx.createParams.compareRemote?.repositoryName) === 0
					&& compareIgnoreCase(ctx.createParams.baseBranch, ctx.createParams.compareBranch) === 0) {

					isCreateable = false;
				}

				const onKeyDown = useCallback(
					e => {
						if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
							e.preventDefault();
							create();
						}
					},
					[create],
				);

				if (!ctx.initialized) {
					return <div className="loading-indicator">Loading...</div>;
				}

				return <div className='group-main'>
					<div className='group-branches'>
						<div className='input-label base'>
							<div className="deco">
								<span title='Base branch'>{prBaseIcon} Base</span>
							</div>
							<ChooseRemoteAndBranch onClick={ctx.changeBaseRemoteAndBranch}
								defaultRemote={params.baseRemote}
								defaultBranch={params.baseBranch}
								isBase={true} />
						</div>

						<div className='input-label merge'>
							<div className="deco">
								<span title='Merge branch'>{prMergeIcon} Merge</span>
							</div>
							<ChooseRemoteAndBranch onClick={ctx.changeMergeRemoteAndBranch}
								defaultRemote={params.compareRemote}
								defaultBranch={params.compareBranch}
								isBase={false} />
						</div>
					</div>

					<div className='group-title'>
						<input
							id='title'
							type='text'
							ref={titleInput}
							name='title'
							className={params.showTitleValidationError ? 'input-error' : ''}
							aria-invalid={!!params.showTitleValidationError}
							aria-describedby={params.showTitleValidationError ? 'title-error' : ''}
							placeholder='Title'
							aria-label='Title'
							title='Required'
							required
							onChange={(e) => updateTitle(e.currentTarget.value)}
							onKeyDown={onKeyDown}>
						</input>
						<div id='title-error' className={params.showTitleValidationError ? 'validation-error below-input-error' : 'hidden'}>A title is required</div>
					</div>

					<div className='group-additions'>
						{ /*
						<div className='assignees'>
							<span title='Assignees'>{assigneeIcon}</span>
							<ul aria-label='Assignees' tabIndex={0}>
								<li>deepak1556</li>
								<li>hbons</li>
								<li>alexr00</li>
								<li>deepak1556</li>
								<li>hbons</li>
								<li>alexr00</li>
								<li>deepak1556</li>
								<li>hbons</li>
								<li>alexr00</li>
							</ul>
						</div>
						<div className='reviewers'>
							<span title='Reviewers'>{reviewerIcon}</span>
							<ul aria-label='Reviewers' tabIndex={0}>
								<li>alexr00</li>
								<li>deepak1556</li>
								<li>hbons</li>
								<li>alexr00</li>
								<li>deepak1556</li>
								<li>hbons</li>
								<li>alexr00</li>
								<li>hbons</li>
							</ul>
						</div>
						*/ }

						{params.labels && (params.labels.length > 0) ?
						<div className='labels'>
							<span title='Labels'>{labelIcon}</span>
							<ul aria-label="Labels" onClick={() => {
								ctx.postMessage({ command: 'pr.changeLabels', args: null });
							}}>
								{params.labels.map(label => <LabelCreate key={label.name} {...label} canDelete isDarkTheme={!!params.isDarkTheme} />)}
							</ul>
						</div>
						: null}

						{ /*
						<div className='milestone'>
							<span title='Milestone'>{milestoneIcon}</span>
							<ul aria-label='Milestone' tabIndex={0}>
								<li>January 2024</li>
							</ul>
						</div>
						*/ }
					</div>

					<div className='group-description'>
						<textarea
							id='description'
							name='description'
							placeholder='Description'
							aria-label='Description'
							value={params.pendingDescription}
							onChange={(e) => ctx.updateState({ pendingDescription: e.currentTarget.value })}
							onKeyDown={onKeyDown}></textarea>
					</div>

					<div className={params.validate && !!params.createError ? 'wrapper validation-error' : 'hidden'} aria-live='assertive'>
						<ErrorBoundary>
							{params.createError}
						</ErrorBoundary>
					</div>

					<div className='group-actions'>
						<div className='merge-method'>
							{gearIcon}
							<select name='merge-method' title='Merge Method' aria-label='Merge Method'>
								<option value='create-merge-commit'>Create Merge Commit</option>
								<option value='quash-and-merge'>Squash and Merge</option>
								<option value='rebase-and-merge' selected>Rebase and Merge</option>
							</select>
						</div>

						<div className='spacer'></div>
						<button disabled={isBusy} className='secondary' onClick={() => ctx.cancelCreate()}>
							Cancel
						</button>
						<div className='create-button'>
							<button className='split-left' disabled={isBusy || !isCreateable} onClick={() => create()}>
								Create
							</button>
							<div className='split-right'>
								{chevronDownIcon}
								<select name='create-action' disabled={isBusy || !isCreateable}
									title='Create Actions' aria-label='Create Actions'>
									<option value='create'>Create</option>
									<option value='create-draft'>Create Draft</option>
									<option value='create-automerge'>Create and Auto-merge</option>
								</select>
							</div>
						</div>
					</div>
				</div>;
			}}
		</Root>,
		document.getElementById('app'),
	);
}

export function Root({ children }) {
	const ctx = useContext(PullRequestContextNew);
	const [pr, setPR] = useState<any>(ctx.createParams);
	useEffect(() => {
		ctx.onchange = setPR;
		setPR(ctx.createParams);
	}, []);
	ctx.postMessage({ command: 'ready' });
	return children(pr);
}
