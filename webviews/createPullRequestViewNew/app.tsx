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
import { Label } from '../common/label';
import { AutoMerge } from '../components/automergeSelect';
import { closeIcon, gearIcon, prBaseIcon, prMergeIcon, chevronDownIcon } from '../components/icon';
import { assigneeIcon, reviewerIcon, labelIcon, milestoneIcon } from '../components/icon';





export const ChooseRemoteAndBranch = ({ onClick, defaultRemote, defaultBranch }:
	{ onClick: (remote?: RemoteInfo, branch?: string) => Promise<void>, defaultRemote: RemoteInfo | undefined, defaultBranch: string | undefined }) => {
	const defaultsLabel = defaultRemote && defaultBranch ? `${defaultRemote.owner}/${defaultBranch}` : '-';

	return <ErrorBoundary>
		<div className='flex'>
			<button title='Choose a repository and branch' className='secondary' onClick={() => {
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
								defaultBranch={params.baseBranch} />
						</div>

						<div className='input-label merge'>
							<div className="deco">
								<span title='Merge branch'>{prMergeIcon} Merge</span>
							</div>
							<ChooseRemoteAndBranch onClick={ctx.changeMergeRemoteAndBranch}
									defaultRemote={params.compareRemote}
									defaultBranch={params.compareBranch} />
						</div>
					</div>

					{params.labels && (params.labels.length > 0) ?
						<div>
							<label className='input-label'>Labels</label>
							<div className='labels-list'>
								{params.labels.map(label => <Label key={label.name} {...label} canDelete isDarkTheme={!!params.isDarkTheme}>
									<button className="icon-button" onClick={() => {
										ctx.postMessage({ command: 'pr.removeLabel', args: { label } });
									}}>
										{closeIcon}️
									</button>
								</Label>)}
							</div>
						</div>
						: null}

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
						<div className='assignees'>
							<span title='Assignees'>{assigneeIcon}</span>
							<ul aria-label='Assignees' tabIndex='0'>
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
							<ul aria-label='Reviewers' tabIndex='0'>
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
						<div className='labels'>
							<span title='Labels'>{labelIcon}</span>
							<ul title='' aria-label='Labels' tabIndex='0'>
							<li>ux</li>
								<li>design</li>
								<li>docs</li>
								<li>macos</li>
								<li>help-wanted</li>
								<li>ux</li>
								<li>design</li>
								<li>docs</li>
								<li>macos</li>
								<li>help-wanted</li>
							</ul>
						</div>
						<div className='milestone'>
							<span title='Milestone'>{milestoneIcon}</span>
							<ul aria-label='Milestone' tabIndex='0'>
								<li>January 2024</li>
							</ul>
						</div>
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
					<AutoMerge {...params} updateState={ctx.updateState}></AutoMerge>

					<div className="group-actions">
						<button className='secondary merge-method'
							title='Merge Method'
							aria-label='Merge Method'>
								{gearIcon}
						</button>
						<div className='spacer'></div>
						<button disabled={isBusy} className="secondary" onClick={() => ctx.cancelCreate()}>
							Cancel
						</button>
						<div className='create-button'>
							<button className='split-left' disabled={isBusy || !isCreateable} onClick={() => create()}>
								Create
							</button>
							<button className='split-right' disabled={isBusy || !isCreateable} onClick={() => create()}
								title='Create Actions' aria-label='Create Actions'>
								{chevronDownIcon}
							</button>
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
