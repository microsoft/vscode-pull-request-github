/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useEffect, useRef, useState } from 'react';

export interface FilterState {
	showTasks: boolean;
	showProjects: boolean;
}

interface FilterButtonProps {
	filterState: FilterState;
	onFilterChange: (filterState: FilterState) => void;
}

export const FilterButton: React.FC<FilterButtonProps> = ({ filterState, onFilterChange }) => {
	const [isDropdownOpen, setIsDropdownOpen] = useState(false);
	const dropdownRef = useRef<HTMLDivElement>(null);

	// Close dropdown when clicking outside
	useEffect(() => {
		const handleClickOutside = (event: MouseEvent) => {
			if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
				setIsDropdownOpen(false);
			}
		};

		if (isDropdownOpen) {
			document.addEventListener('mousedown', handleClickOutside);
		}

		return () => {
			document.removeEventListener('mousedown', handleClickOutside);
		};
	}, [isDropdownOpen]);

	const handleToggleDropdown = () => {
		setIsDropdownOpen(!isDropdownOpen);
	};

	const handleTasksToggle = () => {
		onFilterChange({
			...filterState,
			showTasks: !filterState.showTasks
		});
	};

	const handleProjectsToggle = () => {
		onFilterChange({
			...filterState,
			showProjects: !filterState.showProjects
		});
	};

	const getIcon = () => {
		const isFiltering = !filterState.showTasks || !filterState.showProjects;
		return isFiltering ? 'codicon-filter-filled' : 'codicon-filter';
	};

	const getTooltip = () => {
		if (filterState.showTasks && filterState.showProjects) {
			return 'Filter items (showing all)';
		} else if (filterState.showTasks && !filterState.showProjects) {
			return 'Filter items (showing tasks only)';
		} else if (!filterState.showTasks && filterState.showProjects) {
			return 'Filter items (showing projects only)';
		} else {
			return 'Filter items (showing none)';
		}
	};

	return (
		<div className="filter-dropdown" ref={dropdownRef}>
			<button
				className="filter-button"
				onClick={handleToggleDropdown}
				title={getTooltip()}
			>
				<span className={`codicon ${getIcon()}`}></span>
			</button>
			{isDropdownOpen && (
				<div className="filter-dropdown-menu">
					<div className="filter-dropdown-item" onClick={handleTasksToggle}>
						<span className={`codicon ${filterState.showTasks ? 'codicon-check' : 'codicon-blank'}`}></span>
						<span className="filter-dropdown-label">Tasks</span>
					</div>
					<div className="filter-dropdown-item" onClick={handleProjectsToggle}>
						<span className={`codicon ${filterState.showProjects ? 'codicon-check' : 'codicon-blank'}`}></span>
						<span className="filter-dropdown-label">Projects</span>
					</div>
				</div>
			)}
		</div>
	);
};
