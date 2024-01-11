/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CommentEvent, EventType, ReviewEvent } from '../../src/common/timelineEvent';

export function ariaAnnouncementForReview(comment: ReviewEvent | CommentEvent) {
	const commentTime = (comment as ReviewEvent).submittedAt ?? (comment as CommentEvent).createdAt;
	const veryRecentEvent = commentTime && ((Date.now() - new Date(commentTime).getTime()) < (1000 * 60));
	const commentState = (comment as ReviewEvent).state ?? ((comment as CommentEvent).event === EventType.Commented ? 'COMMENTED' : undefined);
	let ariaAnnouncement = '';
	if (veryRecentEvent) {
		switch (commentState) {
			case 'APPROVED':
				ariaAnnouncement = 'Pull request approved';
				break;
			case 'CHANGES_REQUESTED':
				ariaAnnouncement = 'Changes requested on pull request';
				break;
			case 'COMMENTED':
				ariaAnnouncement = 'Commented on pull request';
				break;
		}
	}
	return ariaAnnouncement;
}