/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IMilestone } from './interface';
import { IssueModel } from './issueModel';

export interface MilestoneModel {
	milestone: IMilestone;
	issues: IssueModel[];
}
