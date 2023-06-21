/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { render } from 'react-dom';
import { CreateParams, RemoteInfo } from '../../common/views';
import { compareIgnoreCase } from '../../src/common/utils';
import PullRequestContext from '../common/createContext';
import { ErrorBoundary } from '../common/errorBoundary';
import { Label } from '../common/label';
import { AutoMerge } from '../components/automergeSelect';
import { closeIcon } from '../components/icon';


export const RemoteSelect = ({ onChange, defaultOption, repos }:
	{ onChange: (owner: string, repositoryName: string) => Promise<void>, defaultOption: string | undefined, repos: RemoteInfo[] }) => {
	let caseCorrectedDefaultOption: string | undefined;
	const options = repos.map(param => {
		const value = param.owner + '/' + param.repositoryName;
		const label = `${param.owner}/${param.repositoryName}`;
		if (label.toLowerCase() === defaultOption) {
			caseCorrectedDefaultOption = label;
		}
		return <option
			key={value}
			value={value}>
			{label}
		</option>;
	});

	return <ErrorBoundary>
		<div className='select-wrapper flex'>
			<select title='Choose a remote' value={caseCorrectedDefaultOption ?? defaultOption} disabled={options.length === 0} onChange={(e) => {
				const [owner, repositoryName] = e.currentTarget.value.split('/');
				onChange(owner, repositoryName);
			}}>
				{options}
			</select>
		</div>
	</ErrorBoundary>;
};

export const BranchSelect = ({ onChange, defaultOption, branches }:
	{ onChange: (branch: string) => void, defaultOption: string | undefined, branches: string[] }) => {
	return <ErrorBoundary>
		<div className='select-wrapper flex'>
			<select title='Choose a branch' value={defaultOption} disabled={branches.length === 0} onChange={(e) => onChange(e.currentTarget.value)}>
				{branches.map(branchName =>
					<option
						key={branchName}
						value={branchName}>
						{branchName}
					</option>
				)}
			</select>
		</div>
	</ErrorBoundary>;
};

export function main() {
	render(
		<Root>
			{(params: CreateParams) => {
				const ctx = useContext(PullRequestContext);
				const [isBusy, setBusy] = useState(false);

				const titleInput = useRef<HTMLInputElement>();

				function updateBaseBranch(branch: string): void {
					ctx.changeBaseBranch(branch);
					ctx.updateState({ baseBranch: branch });
				}

				function updateCompareBranch(branch: string): void {
					ctx.changeCompareBranch(branch);
					ctx.updateState({ compareBranch: branch });
				}

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
						titleInput.current.focus();
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
						<div className='selectors'>
							<div className='labels'>
								<div className='input-label combo-box'>base</div>
								<div className='input-label combo-box'>merge</div>
							</div>
							<div className='selects'>
								<RemoteSelect onChange={ctx.changeCompareRemote}
									defaultOption={`${params.compareRemote?.owner}/${params.compareRemote?.repositoryName}`}
									repos={params.availableCompareRemotes} />

								<BranchSelect onChange={updateCompareBranch} defaultOption={params.compareBranch} branches={params.branchesForCompare} />
							</div>
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
						<button disabled={isBusy} className="secondary" onClick={() => ctx.cancelCreate()}>
							Cancel
						</button>
						<button disabled={isBusy || !isCreateable} onClick={() => create()}>
							Create
						</button>
					</div>
					<div className="wrapper flex">
						<input
							id="draft-checkbox"
							type="checkbox"
							name="draft"
							checked={params.isDraft}
							disabled={params.autoMerge}
							onChange={() => ctx.updateState({ isDraft: !params.isDraft })}
						></input>
						<label htmlFor="draft-checkbox">Create as draft</label>
					</div>
				</div>;
			}}
		</Root>,
		document.getElementById('app'),
	);
}

export function Root({ children }) {
	const ctx = useContext(PullRequestContext);
	const [pr, setPR] = useState<any>(ctx.createParams);
	useEffect(() => {
		ctx.onchange = setPR;
		setPR(ctx.createParams);
	}, []);
	ctx.postMessage({ command: 'ready' });
	return children(pr);
}
