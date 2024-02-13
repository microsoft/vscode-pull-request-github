/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { render } from 'react-dom';
import { CreateParamsNew, RemoteInfo } from '../../common/views';
import { compareIgnoreCase } from '../../src/common/utils';
import { isTeam, MergeMethod } from '../../src/github/interface';
import PullRequestContextNew from '../common/createContextNew';
import { ErrorBoundary } from '../common/errorBoundary';
import { LabelCreate } from '../common/label';
import { ContextDropdown } from '../components/contextDropdown';
import { assigneeIcon, labelIcon, milestoneIcon, prBaseIcon, prMergeIcon, projectIcon, reviewerIcon, sparkleIcon, stopIcon } from '../components/icon';
import { Avatar } from '../components/user';

type CreateMethod = 'create-draft' | 'create' | 'create-automerge-squash' | 'create-automerge-rebase' | 'create-automerge-merge';

export const ChooseRemoteAndBranch = ({ onClick, defaultRemote, defaultBranch, isBase, remoteCount = 0, disabled }:
	{ onClick: (remote?: RemoteInfo, branch?: string) => Promise<void>, defaultRemote: RemoteInfo | undefined, defaultBranch: string | undefined, isBase: boolean, remoteCount: number | undefined, disabled: boolean }) => {

	const defaultsLabel = (defaultRemote && defaultBranch) ? `${remoteCount > 1 ? `${defaultRemote.owner}/` : ''}${defaultBranch}` : '\u2014';
	const title = isBase ? 'Base branch: ' + defaultsLabel : 'Branch to merge: ' + defaultsLabel;

	return <ErrorBoundary>
		<div className='flex'>
			<button className='input-box' title={disabled ? '' : title} aria-label={title} disabled={disabled} onClick={() => {
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
				const [isBusy, setBusy] = useState(params.creating);
				const [isGeneratingTitle, setGeneratingTitle] = useState(false);
				function createMethodLabel(isDraft?: boolean, autoMerge?: boolean, autoMergeMethod?: MergeMethod, baseHasMergeQueue?: boolean): { value: CreateMethod, label: string } {
					let value: CreateMethod;
					let label: string;
					if (autoMerge && baseHasMergeQueue) {
						value = 'create-automerge-merge';
						label = 'Create + Merge When Ready';
					} else if (autoMerge && autoMergeMethod) {
						value = `create-automerge-${autoMergeMethod}` as CreateMethod;
						const mergeMethodLabel = autoMergeMethod.charAt(0).toUpperCase() + autoMergeMethod.slice(1);
						label = `Create + Auto-${mergeMethodLabel}`;
					} else if (isDraft) {
						value = 'create-draft';
						label = 'Create Draft';
					} else {
						value = 'create';
						label = 'Create';
					}

					return {value, label};
				}

				const titleInput = useRef<HTMLInputElement>() as React.MutableRefObject<HTMLInputElement>;

				function updateTitle(title: string): void {
					if (params.validate) {
						ctx.updateState({ pendingTitle: title, showTitleValidationError: !title });
					} else {
						ctx.updateState({ pendingTitle: title });
					}
				}

				useEffect(() => {
					if (ctx.initialized) {
						titleInput.current?.focus();
					}
				}, [ctx.initialized]);

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

				const onKeyDown = useCallback((isTitle: boolean, e) => {
						if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
							e.preventDefault();
							create();
						} else if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
							if (isTitle) {
								ctx.popTitle();
							} else {
								ctx.popDescription();
							}
						}
					},
					[create],
				);

				const onCreateButton: React.MouseEventHandler<HTMLButtonElement> = (event) => {
					const selected = (event.target as HTMLButtonElement).value as CreateMethod;
					let isDraft = false;
					let autoMerge = false;
					let autoMergeMethod: MergeMethod | undefined;
					switch (selected) {
						case 'create-draft':
							isDraft = true;
							autoMerge = false;
							break;
						case 'create-automerge-squash':
							isDraft = false;
							autoMerge = true;
							autoMergeMethod = 'squash';
							break;
						case 'create-automerge-rebase':
							isDraft = false;
							autoMerge = true;
							autoMergeMethod = 'rebase';
							break;
						case 'create-automerge-merge':
							isDraft = false;
							autoMerge = true;
							autoMergeMethod = 'merge';
							break;
					}
					ctx.updateState({ isDraft, autoMerge, autoMergeMethod });
					return create();
				};

				function makeCreateMenuContext(createParams: CreateParamsNew) {
					const createMenuContexts = {
						'preventDefaultContextMenuItems': true,
						'github:createPrMenu': true,
						'github:createPrMenuDraft': true
					};
					if (createParams.baseHasMergeQueue) {
						createMenuContexts['github:createPrMenuMergeWhenReady'] = true;
					} else {
						if (createParams.allowAutoMerge && createParams.mergeMethodsAvailability && createParams.mergeMethodsAvailability['merge']) {
							createMenuContexts['github:createPrMenuMerge'] = true;
						}
						if (createParams.allowAutoMerge && createParams.mergeMethodsAvailability && createParams.mergeMethodsAvailability['squash']) {
							createMenuContexts['github:createPrMenuSquash'] = true;
						}
						if (createParams.allowAutoMerge && createParams.mergeMethodsAvailability && createParams.mergeMethodsAvailability['rebase']) {
							createMenuContexts['github:createPrMenuRebase'] = true;
						}
					}
					const stringified = JSON.stringify(createMenuContexts);
					return stringified;
				}

				if (params.creating) {
					create();
				}

				function activateCommand(event: MouseEvent | KeyboardEvent, command: string): void {
					if (event instanceof KeyboardEvent) {
						if (event.key === 'Enter' || event.key === ' ') {
							event.preventDefault();
							ctx.postMessage({ command: command });
						}
					} else if (event instanceof MouseEvent) {
						ctx.postMessage({ command: command });
					}
				}

				async function generateTitle(useCopilot?: boolean) {
					setGeneratingTitle(true);
					await ctx.generateTitle(!!useCopilot);
					setGeneratingTitle(false);
				}

				if (!ctx.initialized) {
					ctx.initialize();
				}

				if (ctx.createParams.initializeWithGeneratedTitleAndDescription) {
					ctx.createParams.initializeWithGeneratedTitleAndDescription = false;
					generateTitle(true);
				}

				return <div className='group-main' data-vscode-context='{"preventDefaultContextMenuItems": true}'>
					<div className='group-branches'>
						<div className='input-label base'>
							<div className="deco">
								<span title='Base branch' aria-hidden='true'>{prBaseIcon} Base</span>
							</div>
							<ChooseRemoteAndBranch onClick={ctx.changeBaseRemoteAndBranch}
								defaultRemote={params.baseRemote}
								defaultBranch={params.baseBranch}
								remoteCount={params.remoteCount}
								isBase={true}
								disabled={!ctx.initialized || isBusy} />
						</div>

						<div className='input-label merge'>
							<div className="deco">
								<span title='Merge branch' aria-hidden='true'>{prMergeIcon} Merge</span>
							</div>
							<ChooseRemoteAndBranch onClick={ctx.changeMergeRemoteAndBranch}
								defaultRemote={params.compareRemote}
								defaultBranch={params.compareBranch}
								remoteCount={params.remoteCount}
								isBase={false}
								disabled={!ctx.initialized || isBusy} />
						</div>
					</div>

					<div className='group-title'>
						<input
							id='title'
							type='text'
							ref={titleInput}
							name='title'
							value={params.pendingTitle ?? ''}
							className={params.showTitleValidationError ? 'input-error' : ''}
							aria-invalid={!!params.showTitleValidationError}
							aria-describedby={params.showTitleValidationError ? 'title-error' : ''}
							placeholder='Title'
							aria-label='Title'
							title='Required'
							required
							onChange={(e) => updateTitle(e.currentTarget.value)}
							onKeyDown={(e) => onKeyDown(true, e)}
							data-vscode-context='{"preventDefaultContextMenuItems": false}'
							disabled={!ctx.initialized || isBusy || isGeneratingTitle}>
						</input>
						{ctx.createParams.generateTitleAndDescriptionTitle ?
							isGeneratingTitle ?
								<a title='Cancel' className={`title-action icon-button${isBusy || !ctx.initialized ? ' disabled' : ''}`} onClick={ctx.cancelGenerateTitle} tabIndex={0}>{stopIcon}</a>
								: <a title={ctx.createParams.generateTitleAndDescriptionTitle} className={`title-action icon-button${isBusy || !ctx.initialized ? ' disabled' : ''}`} onClick={() => generateTitle()} tabIndex={0}>{sparkleIcon}</a> : null}
						<div id='title-error' className={params.showTitleValidationError ? 'validation-error below-input-error' : 'hidden'}>A title is required</div>
					</div>

					<div className='group-additions'>
						{params.assignees && (params.assignees.length > 0) ?
							<div className='assignees'>
								<span title='Assignees' aria-hidden='true'>{assigneeIcon}</span>
								<ul aria-label='Assignees' tabIndex={0} role='button'
									onClick={(e) => activateCommand(e.nativeEvent, 'pr.changeAssignees')}
									onKeyPress={(e) => activateCommand(e.nativeEvent, 'pr.changeAssignees')}
								>
									{params.assignees.map(assignee =>
										<li>
											<span title={assignee.name} aria-label={assignee.name}>
												<Avatar for={assignee} link={false} />
												{assignee.login}
											</span>
										</li>)}
								</ul>
							</div>
							: null}

						{params.reviewers && (params.reviewers.length > 0) ?
							<div className='reviewers'>
								<span title='Reviewers' aria-hidden='true'>{reviewerIcon}</span>
								<ul aria-label='Reviewers' tabIndex={0} role='button'
									onClick={(e) => activateCommand(e.nativeEvent, 'pr.changeReviewers')}
									onKeyPress={(e) => activateCommand(e.nativeEvent, 'pr.changeReviewers')}
								>
									{params.reviewers.map(reviewer =>
										<li>
											<span title={reviewer.name} aria-label={reviewer.name}>
												<Avatar for={reviewer} link={false} />
												{isTeam(reviewer) ? reviewer.slug : reviewer.login}
											</span>
										</li>)}
								</ul>
							</div>
							: null}

						{params.labels && (params.labels.length > 0) ?
							<div className='labels'>
								<span title='Labels' aria-hidden='true'>{labelIcon}</span>
								<ul aria-label='Labels' tabIndex={0} role='button'
									onClick={(e) => activateCommand(e.nativeEvent, 'pr.changeLabels')}
									onKeyPress={(e) => activateCommand(e.nativeEvent, 'pr.changeLabels')}
								>
									{params.labels.map(label => <LabelCreate key={label.name} {...label} canDelete isDarkTheme={!!params.isDarkTheme} />)}
								</ul>
							</div>
						: null}

						{params.milestone ?
							<div className='milestone'>
								<span title='Milestone' aria-hidden='true'>{milestoneIcon}</span>
								<ul aria-label='Milestone' tabIndex={0} role='button'
									onClick={(e) => activateCommand(e.nativeEvent, 'pr.changeMilestone')}
									onKeyPress={(e) => activateCommand(e.nativeEvent, 'pr.changeMilestone')}
								>
									<li>
										{params.milestone.title}
									</li>
								</ul>
							</div>
							: null}

						{params.projects && (params.projects.length > 0) ?
							<div className='projects'>
								<span title='Projects' aria-hidden='true'>{projectIcon}</span>
								<ul aria-label='Project' tabIndex={0} role='button'
									onClick={(e) => activateCommand(e.nativeEvent, 'pr.changeProjects')}
									onKeyPress={(e) => activateCommand(e.nativeEvent, 'pr.changeProjects')}
								>
									<li>
										{params.projects.map(project => <span key={project.id}>{project.title}</span>)}
									</li>
								</ul>
							</div>
							: null}
					</div>

					<div className='group-description'>
						<textarea
							id='description'
							name='description'
							placeholder='Description'
							aria-label='Description'
							value={params.pendingDescription}
							onChange={(e) => ctx.updateState({ pendingDescription: e.currentTarget.value })}
							onKeyDown={(e) => onKeyDown(false, e)}
							data-vscode-context='{"preventDefaultContextMenuItems": false}'
							disabled={!ctx.initialized || isBusy || isGeneratingTitle}></textarea>
					</div>

					<div className={params.validate && !!params.createError ? 'wrapper validation-error' : 'hidden'} aria-live='assertive'>
						<ErrorBoundary>
							{params.createError}
						</ErrorBoundary>
					</div>

					<div className='group-actions'>
						<button disabled={isBusy} className='secondary' onClick={() => ctx.cancelCreate()}>
							Cancel
						</button>

						<ContextDropdown optionsContext={() => makeCreateMenuContext(params)}
							defaultAction={onCreateButton}
							defaultOptionLabel={() => createMethodLabel(ctx.createParams.isDraft, ctx.createParams.autoMerge, ctx.createParams.autoMergeMethod, ctx.createParams.baseHasMergeQueue).label}
							defaultOptionValue={() => createMethodLabel(ctx.createParams.isDraft, ctx.createParams.autoMerge, ctx.createParams.autoMergeMethod, ctx.createParams.baseHasMergeQueue).value}
							optionsTitle='Create with Option'
							disabled={isBusy || isGeneratingTitle || !isCreateable || !ctx.initialized}
						/>

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
