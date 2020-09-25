/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { PullRequest } from '../common/cache';

import { AddCommentSimple } from '../components/comment';
import { StatusChecks } from '../components/merge'

export const Overview = (pr: PullRequest) =>
	<>
		<div id='main'>
			<AddCommentSimple {...pr} />
			<StatusChecks pr={pr} isSimple={true} />
		</div>
	</>;
