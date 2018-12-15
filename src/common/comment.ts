/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as Github from '@octokit/rest';
import { DiffHunk } from './diffHunk';

export interface Comment extends Github.PullRequestsCreateCommentResponse {
	absolutePosition?: number;
	diff_hunks?: DiffHunk[];
	canEdit?: boolean;
	canDelete?: boolean;
	isDraft?: boolean;
}
