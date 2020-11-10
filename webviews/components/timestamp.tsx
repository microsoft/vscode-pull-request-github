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
}) => {
	const title = typeof date === 'string' ? new Date(date).toLocaleString() : date.toLocaleString();
	return href
		? <a href={href} className='timestamp' title={title}>{dateFromNow(date)}</a>
		: <div className='timestamp' title={title} >{dateFromNow(date)}</div>;
}

export default Timestamp;