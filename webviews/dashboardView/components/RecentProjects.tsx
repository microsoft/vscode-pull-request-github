/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React from 'react';
import { ProjectData, vscode } from '../types';

interface RecentProjectsProps {
	projects: readonly ProjectData[];
}

export const RecentProjects: React.FC<RecentProjectsProps> = ({ projects }) => {
	const handleProjectClick = (project: ProjectData) => {
		vscode.postMessage({
			command: 'open-project',
			args: { path: project.path }
		});
	};

	const handleMoreClick = () => {
		vscode.postMessage({ command: 'show-more-projects' });
	};

	return (
		<div className="recent-projects">
			<h3 className="area-header">Recent</h3>
			<div className="projects-list">
				{projects.map((project) => (
					<div
						key={project.path}
						className="project-item"
						onClick={() => handleProjectClick(project)}
					>
						<div className="project-name">{project.name}</div>
						<div className="project-path">{project.path}</div>
					</div>
				))}
				<button className="more-projects-button" onClick={handleMoreClick}>
					More...
				</button>
			</div>
		</div>
	);
};