/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';

import { dateFromNow } from '../../src/common/utils';

export const Timestamp = ({
	date,
	href,
}: {
	date: Date | string,
	href?: string
}) =>
	href
	? <a href={href} className='timestamp'>{dateFromNow(date)}</a>
	: <div className='timestamp'>{dateFromNow(date)}</div>;

export default Timestamp;