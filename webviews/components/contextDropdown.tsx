/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useEffect, useState } from 'react';
import { chevronDownIcon } from './icon';

interface ContextDropdownProps {
	optionsContext: () => string;
	defaultOptionLabel: () => string;
	defaultOptionValue: () => string;
	defaultAction: (event: React.MouseEvent<HTMLButtonElement, MouseEvent>) => void;
	optionsTitle: string;
	disabled?: boolean;
	hasSingleAction?: boolean;
}

export const ContextDropdown = ({ optionsContext, defaultOptionLabel, defaultOptionValue, defaultAction, optionsTitle, disabled, hasSingleAction }: ContextDropdownProps) => {
	const [expanded, setExpanded] = useState(false);
	const onHideAction = (e: MouseEvent | KeyboardEvent) => {
		if (e.target instanceof HTMLElement && e.target.classList.contains('split-right')) {
			return;
		}
		setExpanded(false);
	};
	useEffect(() => {
		const onClickOrKey = (e) => onHideAction(e);
		if (expanded) {
			document.addEventListener('click', onClickOrKey);
			document.addEventListener('keydown', onClickOrKey);
		} else {
			document.removeEventListener('click', onClickOrKey);
			document.removeEventListener('keydown', onClickOrKey);
		}
	}, [expanded, setExpanded]);
	return <div className='primary-split-button'>
		<button className='split-left' disabled={disabled} onClick={defaultAction} value={defaultOptionValue()}
			title={defaultOptionLabel()}>
			{defaultOptionLabel()}
		</button>
		<div className='split'></div>
		{hasSingleAction ? null :
			<button className='split-right' title={optionsTitle} disabled={disabled} aria-expanded={expanded} onClick={(e) => {
				e.preventDefault();
				const rect = (e.target as HTMLElement).getBoundingClientRect();
				const x = rect.left;
				const y = rect.bottom;
				e.target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: x, clientY: y }));
				e.stopPropagation();
			}}
			onMouseDown={() => setExpanded(true)}
			onKeyDown={(e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					setExpanded(true);
				}
			}}
			data-vscode-context={optionsContext()}>
				{chevronDownIcon}
			</button>
		}
	</div>;
};