/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React from 'react';

interface EmptyStateProps {
	message: string;
}

export const EmptyState: React.FC<EmptyStateProps> = ({ message }) => {
	return (
		<div className="empty-state">
			{message}
		</div>
	);
};