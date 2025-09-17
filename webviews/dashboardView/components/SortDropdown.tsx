/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React from 'react';

interface SortDropdownProps {
	issueSort: 'date-oldest' | 'date-newest' | 'complexity-low' | 'complexity-high';
	onSortChange: (sortType: 'date-oldest' | 'date-newest' | 'complexity-low' | 'complexity-high') => void;
}

export const SortDropdown: React.FC<SortDropdownProps> = ({
	issueSort,
	onSortChange
}) => {
	return (
		<div className="sort-dropdown">
			<select
				value={issueSort}
				onChange={(e) => onSortChange(e.target.value as any)}
				className="sort-select"
			>
				<option value="date-oldest">Date (oldest first)</option>
				<option value="date-newest">Date (newest first)</option>
				<option value="complexity-low">Complexity (lowest first)</option>
				<option value="complexity-high">Complexity (highest first)</option>
			</select>
		</div>
	);
};