/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React from 'react';

interface LoadingStateProps {
	message: string;
}

export const LoadingState: React.FC<LoadingStateProps> = ({ message }) => {
	return (
		<div className="section-loading">
			<span className="codicon codicon-sync codicon-modifier-spin"></span>
			<span>{message}</span>
		</div>
	);
};