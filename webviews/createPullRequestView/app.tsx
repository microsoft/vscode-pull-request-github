/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { useContext, useState, useEffect, useRef } from 'react';
import { render } from 'react-dom';
import PullRequestContext, { CreateParams } from '../common/createContext';
import { gitCompareIcon, repoIcon } from '../components/icon';

export function main() {
	render(
		<Root>{(params: CreateParams) => {
			const ctx = useContext(PullRequestContext);
			const [isBusy, setBusy] = useState(false);

			const titleInput = useRef<HTMLInputElement>();

			function updateBaseBranch(branch: string): void {
				ctx.changeBaseBranch(branch);
				ctx.updateState({ baseBranch: branch });
			}

			function updateTitle(title: string): void {
				params.validate
					? ctx.updateState({ pendingTitle: title, showTitleValidationError: !title })
					: ctx.updateState({ pendingTitle: title });
			}

			async function create(): Promise<void> {
				setBusy(true);
				const hasValidTitle = await ctx.validate();
				if (!hasValidTitle) {
					titleInput.current.focus();
				} else {
					await ctx.submit();
				}
				setBusy(false);
			}

			return <div>
				Choose a base branch to compare the '<b>{params.compareBranch}</b>' branch to.

				<div className='wrapper flex'>
					{repoIcon}<select value={`${params.baseRemote?.owner}/${params.baseRemote?.repositoryName}`} onChange={(e) => {
						const [owner, repositoryName] = e.currentTarget.value.split('/');
						ctx.changeBaseRemote(owner, repositoryName);
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

				<div className='wrapper flex'>
					{gitCompareIcon}<select value={params.baseBranch} onChange={(e) => updateBaseBranch(e.currentTarget.value)}>
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
					<input
						type='text'
						ref={titleInput}
						name='title'
						className={params.showTitleValidationError ? 'input-error' : ''}
						aria-invalid={!!params.showTitleValidationError}
						aria-describedBy={params.showTitleValidationError ? 'title-error' : ''}
						placeholder='Pull Request Title'
						value={params.pendingTitle}
						required
						onChange={(e) => updateTitle(e.currentTarget.value)}>
					</input>
					<div id='title-error' className={params.showTitleValidationError ? 'validation-error below-input-error' : 'hidden'}>A title is required.</div>
				</div>

				<div className='wrapper'>
					<textarea name='description' placeholder='Pull Request Description' value={params.pendingDescription} required onChange={(e) => ctx.updateState({ pendingDescription: e.currentTarget.value })}></textarea>
				</div>

				<div className={params.validate && !!params.createError ? 'wrapper validation-error' : 'hidden'} aria-live='assertive'>
					{params.createError}
				</div>

				<div className='wrapper flex'>
					<input id='draft-checkbox' type='checkbox' name='draft' checked={params.isDraft} onClick={() => ctx.updateState({ isDraft: !params.isDraft })}></input>
					<label htmlFor='draft-checkbox'>Create as draft</label>
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