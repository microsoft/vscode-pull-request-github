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

		// Calculate appropriate update interval based on how old the timestamp is
		const getUpdateInterval = () => {
			const now = Date.now();
			const timestamp = typeof date === 'string' ? new Date(date).getTime() : date.getTime();
			const ageInMinutes = (now - timestamp) / (1000 * 60);
			
			// For very recent timestamps (< 1 minute), update every 20 seconds
			if (ageInMinutes < 1) {
				return 20000; // 20 seconds
			}
			// For timestamps < 1 hour old, update every 2 minutes
			else if (ageInMinutes < 60) {
				return 2 * 60000; // 2 minutes
			}
			// For older timestamps (> 1 day), don't update at all
			else if (ageInMinutes >= 60 * 24) {
				return null; // Don't update
			}
			// For timestamps between 1 hour and 1 day, update every 2 minutes
			else {
				return 2 * 60000; // 2 minutes
			}
		};

		const intervalDuration = getUpdateInterval();
		
		// If intervalDuration is null, don't set up any updates for very old timestamps
		if (intervalDuration === null) {
			return;
		}
		
		let intervalId: number;

		const updateTimeString = () => {
			// Only update if the page is visible
			if (document.visibilityState === 'visible') {
				setTimeString(dateFromNow(date));
			}
		};

		const startInterval = () => {
			intervalId = window.setInterval(updateTimeString, intervalDuration);
		};

		const handleVisibilityChange = () => {
			if (document.visibilityState === 'visible') {
				// Page became visible, update immediately and restart interval
				setTimeString(dateFromNow(date));
				if (intervalId) {
					clearInterval(intervalId);
				}
				startInterval();
			} else {
				// Page became hidden, pause the interval
				if (intervalId) {
					clearInterval(intervalId);
				}
			}
		};

		// Start the interval
		startInterval();

		// Listen for visibility changes
		document.addEventListener('visibilitychange', handleVisibilityChange);

		// Clean up on component unmount
		return () => {
			if (intervalId) {
				clearInterval(intervalId);
			}
			document.removeEventListener('visibilitychange', handleVisibilityChange);
		};
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
