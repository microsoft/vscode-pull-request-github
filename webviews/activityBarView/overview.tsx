/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React from 'react';
import { PullRequest } from '../../src/github/views';

import { AddCommentSimple } from '../components/comment';
import { StatusChecksSection } from '../components/merge';
import { ExitSection } from './exit';

export const Overview = (pr: PullRequest) => {
	return <>
		<div id="main">
			<AddCommentSimple {...pr} />
			<StatusChecksSection pr={pr} isSimple={true} />
			<ExitSection pr={pr} />
		</div>
	</>;
};

