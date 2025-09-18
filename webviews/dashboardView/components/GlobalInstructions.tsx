/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React from 'react';

interface GlobalInstructionsProps {
	onAgentClick?: (agent: string) => void;
}

export const GlobalInstructions: React.FC<GlobalInstructionsProps> = ({ onAgentClick }) => {
	const handleAgentClick = (agent: string) => {
		if (onAgentClick) {
			onAgentClick(agent);
		}
	};

	return (
		<div className="global-instructions">
			<div className="instructions-content">
				<p>
					<strong>Reference issues:</strong> Use the syntax <code>org/repo#123</code> to start work on specific issues from any repository.
				</p>
				<p>
					<strong>Choose your agent:</strong> Use <code
						style={{ cursor: 'pointer' }}
						onClick={() => handleAgentClick('@local ')}
						title="Click to add @local to input"
					>@local</code> to work locally or <code
						style={{ cursor: 'pointer' }}
						onClick={() => handleAgentClick('@copilot ')}
						title="Click to add @copilot to input"
					>@copilot</code> to use GitHub Copilot.
				</p>
				<p>
					<strong>Mention projects:</strong> You can talk about projects by name to work across multiple repositories.
				</p>
			</div>
		</div>
	);
};
