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
import { closeIcon, gearIcon, prBaseIcon, prMergeIcon } from '../components/icon';





export const ChooseRemoteAndBranch = ({ onClick, defaultRemote, defaultBranch }:
	{ onClick: (remote?: RemoteInfo, branch?: string) => Promise<void>, defaultRemote: RemoteInfo | undefined, defaultBranch: string | undefined }) => {
	const defaultsLabel = defaultRemote && defaultBranch ? `${defaultRemote.owner}/${defaultBranch}` : '-';

	return <ErrorBoundary>
		<div className='select-wrapper flex'>
			<button title='Choose a remote' onClick={() => {
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

				return <div>
					<div className='selector-group'>

							<div className='input-label combo-box base'>{prBaseIcon} base <div className='select'>Select</div></div>


						<div className='input-label combo-box merge'>{prMergeIcon} merge <div className='select'>Select</div></div>

						<div className="dropdowns">


							<ChooseRemoteAndBranch onClick={ctx.changeBaseRemoteAndBranch}
									defaultRemote={params.baseRemote}
									defaultBranch={params.baseBranch} />
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

					<div className='wrapper'>
						<input
							id='title'
							type='text'
							ref={titleInput}
							name='title'
							className={params.showTitleValidationError ? 'input-error' : ''}
							aria-invalid={!!params.showTitleValidationError}
							aria-describedby={params.showTitleValidationError ? 'title-error' : ''}
							placeholder='Title'
							required
							onChange={(e) => updateTitle(e.currentTarget.value)}
							onKeyDown={onKeyDown}>
						</input>
						<div id='title-error' className={params.showTitleValidationError ? 'validation-error below-input-error' : 'hidden'}>A title is required.</div>
					</div>

					<div className='wrapper'>
						<textarea
							id='description'
							name='description'
							placeholder='Description'
							value={params.pendingDescription}
							required
							onChange={(e) => ctx.updateState({ pendingDescription: e.currentTarget.value })}
							onKeyDown={onKeyDown}></textarea>
					</div>

					<div className={params.validate && !!params.createError ? 'wrapper validation-error' : 'hidden'} aria-live='assertive'>
						<ErrorBoundary>
							{params.createError}
						</ErrorBoundary>
					</div>
					<AutoMerge {...params} updateState={ctx.updateState}></AutoMerge>

					<div className="actions">
						<a
							className=''
							title="Add">{gearIcon}
						</a>
						<button disabled={isBusy} className="secondary" onClick={() => ctx.cancelCreate()}>
							Cancel
						</button>
						<button disabled={isBusy || !isCreateable} onClick={() => create()}>
							Create
						</button>
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
