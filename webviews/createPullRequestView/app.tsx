/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { useContext, useState, useEffect } from 'react';
import { render } from 'react-dom';
import PullRequestContext, { CreateParams } from '../common/createContext';
import { gitCompareIcon, repoIcon } from '../components/icon';

export function main() {
	render(
		<Root>{(params: CreateParams) => {
			const ctx = useContext(PullRequestContext);
			const [isBusy, setBusy] = useState(false);

			function updateSelectedBranch(branch: string): void {
				ctx.changeBranch(branch);
				ctx.updateState({ selectedBranch: branch });
			}

			function updateTitle(title: string): void {
				params.validate
					? ctx.updateState({ pendingTitle: title, showTitleValidationError: !title })
					: ctx.updateState({ pendingTitle: title });
			}

			function updateDescription(description: string): void {
				params.validate
					? ctx.updateState({ pendingDescription: description, showDescriptionValidationError: !description })
					: ctx.updateState({ pendingDescription: description });
			}

			async function create(): Promise<void> {
				setBusy(true);
				await ctx.submit();
				setBusy(false);
			}

			return <div>
				Choose a branch to compare to the current branch.

				<div className='wrapper'>
					{repoIcon}<select value={`${params.selectedRemote?.owner}/${params.selectedRemote?.repositoryName}`} onChange={(e) => {
						const [owner, repositoryName] = e.currentTarget.value.split('/');
						ctx.changeRemote(owner, repositoryName);
					}}>
						{params.availableRemotes.map(param => {
							const value = param.owner + '/' + param.repositoryName;

							return <option
								key={value}
								value={value}>
								{param.owner}/{param.repositoryName}
							</option>;
						}

						)}
					</select>
				</div>

				<div className='wrapper'>
					{gitCompareIcon}<select value={params.selectedBranch} onChange={(e) => updateSelectedBranch(e.currentTarget.value)}>
						{params.branchesForRemote.map(branchName =>
							<option
								key={branchName}
								value={branchName}>
								{branchName}
							</option>
						)}
					</select>
				</div>

				<div className='wrapper'>
					<input type='text' name='title' className={params.showTitleValidationError ? 'input-error' : ''} placeholder='Pull Request Title' value={params.pendingTitle} required onChange={(e) => updateTitle(e.currentTarget.value)}></input>
					<div className={params.showTitleValidationError ? 'validation-error below-input-error' : 'hidden'}>A title is required.</div>
				</div>


				<div className='wrapper'>
					<textarea name='description' className={params.showDescriptionValidationError ? 'input-error' : ''} placeholder='Pull Request Description' value={params.pendingDescription} required onChange={(e) => updateDescription(e.currentTarget.value)}></textarea>
				</div>
				<div className={params.showDescriptionValidationError ? 'validation-error below-input-error' : 'hidden'}>A description is required.</div>

				<div className={params.validate && !!params.createError ? 'wrapper validation-error' : 'hidden'}>
					{params.createError}
				</div>

				<div className='actions'>
					<button disabled={isBusy} className='secondary' onClick={() => ctx.cancelCreate()}>Cancel</button>
					<button disabled={isBusy} onClick={() => create()}>Create</button>
				</div>
			</div>;
		}}</Root>
		, document.getElementById('app'));
}

export function Root({ children }) {
	const ctx = useContext(PullRequestContext);
	const [pr, setPR] = useState<any>(ctx.createParams);
	useEffect(() => {
		ctx.onchange = setPR;
		setPR(ctx.createParams);
	}, []);
	ctx.postMessage({ command: 'ready' });
	return pr ? children(pr) : <div className='loading-indicator'>Loading...</div>;
}