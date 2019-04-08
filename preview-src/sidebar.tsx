import * as React from 'react';
import { cloneElement, useContext } from 'react';
import { PullRequest } from './cache';
import { Avatar, AuthorLink } from './user';
import { pendingIcon, commentIcon, checkIcon, diffIcon, plusIcon } from './icon';
import PullRequestContext from './context';

export default function Sidebar({ reviewers, labels }: PullRequest) {
	const { addReviewers, addLabels } = useContext(PullRequestContext);
	return <div id='sidebar'>
		<div id='reviewers' className='section'>
			<div className='section-header'>
				<div>Reviewers</div>
				<button title='Add Reviewers' onClick={addReviewers}>{plusIcon}</button>
			</div>
			{
				reviewers.map(({ reviewer, state }) =>
					<div className='section-item reviewer'>
						<Avatar for={reviewer} />
						<AuthorLink for={reviewer} />
						{REVIEW_STATE[state]}
					</div>
				)
			}
		</div>
		<div id='labels' className='section'>
			<div className='section-header'>
				<div>Labels</div>
				<button title='Add Labels' onClick={addLabels}>{plusIcon}</button>
			</div>
			{
				labels.map(({ name }) =>
					<div className='section-item label'>
						{name}
					</div>
				)
			}
		</div>
	</div>;
}

const REVIEW_STATE: { [state: string]: React.ReactElement } = {
	REQUESTED: cloneElement(pendingIcon, { className: 'push-right', title: 'Awaiting requested review' }),
	COMMENTED: cloneElement(commentIcon, { className: 'push-right', Root: 'div', title: 'Left review comments' }),
	APPROVED: cloneElement(checkIcon, { className: 'push-right', title: 'Approved these changes' }),
	CHANGES_REQUESTED: cloneElement(diffIcon, { className: 'push-right', title: 'Requested changes' }),
};