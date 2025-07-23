/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { chevronDownIcon } from './icon';

interface ContextDropdownProps {
	optionsContext: () => string;
	defaultOptionLabel: () => string;
	defaultOptionValue: () => string;
	defaultAction: (event: React.MouseEvent<HTMLButtonElement, MouseEvent>) => void;
	allOptions?: () => { label: string; value: string; action: (event: React.MouseEvent<HTMLButtonElement, MouseEvent>) => void }[];
	optionsTitle: string;
	disabled?: boolean;
	hasSingleAction?: boolean;
	spreadable: boolean;
	isSecondary?: boolean;
}

function useWindowSize() {
	const [size, setSize] = useState([0, 0]);
	useLayoutEffect(() => {
		function updateSize() {
			setSize([window.innerWidth, window.innerHeight]);
		}
		window.addEventListener('resize', updateSize);
		updateSize();
		return () => window.removeEventListener('resize', updateSize);
	}, []);
	return size;
}

export const ContextDropdown = ({ optionsContext, defaultOptionLabel, defaultOptionValue, defaultAction, allOptions: options, optionsTitle, disabled, hasSingleAction, spreadable, isSecondary }: ContextDropdownProps) => {
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

	const divRef = useRef<HTMLDivElement>();
	useWindowSize();

	return <div className={`dropdown-container${spreadable ? ' spreadable' : ''}`} ref={divRef}>
		{divRef.current && spreadable && (divRef.current.clientWidth > 375) && options && !hasSingleAction ? options().map(({ label, value, action }) => {
			return <button className='inlined-dropdown' key={value} title={label} disabled={disabled} onClick={action} value={value}>{label}</button>;
		})
			:
			<div className='primary-split-button'>
				<button className={`split-left${isSecondary ? ' secondary' : ''}`} disabled={disabled} onClick={defaultAction} value={defaultOptionValue()}
					title={defaultOptionLabel()}>
					{defaultOptionLabel()}
				</button>
				{hasSingleAction ? null :
					<div className={`split${isSecondary ? ' secondary' : ''}${disabled ? ' disabled' : ''}`}><div className={`separator${disabled ? ' disabled' : ''}`}></div></div>
				}
				{hasSingleAction ? null :
					<button className={`split-right${isSecondary ? ' secondary' : ''}`} title={optionsTitle} disabled={disabled} aria-expanded={expanded} onClick={(e) => {
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
			</div>
		}
	</div>;
};