/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React from 'react';
import { vscode } from '../util';

export const QuickActions: React.FC = () => {
	const handleNewFile = () => {
		vscode.postMessage({ command: 'new-file' });
	};

	const handleOpenFolder = () => {
		vscode.postMessage({ command: 'open-folder' });
	};

	const handleCloneRepository = () => {
		vscode.postMessage({ command: 'clone-repository' });
	};

	const handleConnectTo = () => {
		vscode.postMessage({ command: 'connect-to' });
	};

	const handleGenerateWorkspace = () => {
		vscode.postMessage({ command: 'generate-workspace' });
	};

	return (
		<div>
			<div className="quick-action-button" onClick={handleNewFile}>
				<span className="codicon codicon-new-file"></span>
				<span>New File...</span>
			</div>
			<div className="quick-action-button" onClick={handleOpenFolder}>
				<span className="codicon codicon-folder-opened"></span>
				<span>Open...</span>
			</div>
			<div className="quick-action-button" onClick={handleCloneRepository}>
				<span className="codicon codicon-repo-clone"></span>
				<span>Clone Git Repository...</span>
			</div>
			<div className="quick-action-button" onClick={handleConnectTo}>
				<span className="codicon codicon-plug"></span>
				<span>Connect to...</span>
			</div>
			<div className="quick-action-button" onClick={handleGenerateWorkspace}>
				<span className="codicon codicon-workspace-trusted"></span>
				<span>Generate New Workspace...</span>
			</div>
		</div>
	);
};