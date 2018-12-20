/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as Github from '@octokit/rest';

export interface CheckRunWithAnnotations {
	checkRun: Github.ChecksListForRefResponseCheckRunsItem;
	annotations: Github.ChecksListAnnotationsResponseItem[];
}
