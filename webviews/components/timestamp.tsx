/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useEffect, useState } from 'react';

import { dateFromNow } from '../../src/common/utils';

export const Timestamp = ({ date, href }: { date: Date | string; href?: string }) => {
	const [timeString, setTimeString] = useState(dateFromNow(date));
	const title = typeof date === 'string' ? new Date(date).toLocaleString() : date.toLocaleString();

	useEffect(() => {
		// Update the time string immediately
		setTimeString(dateFromNow(date));

		// Set up an interval to update the time string every minute
		const intervalId = setInterval(() => {
			setTimeString(dateFromNow(date));
		}, 60000); // Update every 60 seconds

		// Clean up the interval on component unmount
		return () => clearInterval(intervalId);
	}, [date]);

	return href ? (
		<a href={href} className="timestamp" title={title}>
			{timeString}
		</a>
	) : (
		<div className="timestamp" title={title}>
			{timeString}
		</div>
	);
};

export default Timestamp;
