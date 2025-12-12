/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useState } from 'react';
import { v4 as uuid } from 'uuid';
import { chevronIcon } from './icon';

const enum KEYCODES {
	esc = 27,
	down = 40,
	up = 38,
}

export const Dropdown = ({ options, defaultOption, disabled, submitAction, changeAction }: { options: { [key: string]: string }, defaultOption: string, disabled?: boolean, submitAction: (string) => Promise<void>, changeAction?: (string) => Promise<void> }) => {
	const [selectedMethod, selectMethod] = useState<string>(defaultOption);
	const [areOptionsVisible, setOptionsVisible] = useState<boolean>(false);

	const dropdownId = uuid();
	const EXPAND_OPTIONS_BUTTON = `expandOptions${dropdownId}`;

	const onClick = () => {
		setOptionsVisible(!areOptionsVisible);
	};

	const onMethodChange = e => {
		selectMethod(e.target.value);
		setOptionsVisible(false);
		const primaryButton = document.getElementById(`confirm-button${dropdownId}`);
		primaryButton?.focus();
		if (changeAction) {
			changeAction(e.target.value);
		}
	};

	const onKeyDown = e => {
		if (areOptionsVisible) {
			const currentElement = document.activeElement;

			switch (e.keyCode) {
				case KEYCODES.esc:
					setOptionsVisible(false);
					const expandOptionsButton = document.getElementById(EXPAND_OPTIONS_BUTTON);
					expandOptionsButton?.focus();
					break;

				case KEYCODES.down:
					if (!currentElement?.id || currentElement.id === EXPAND_OPTIONS_BUTTON) {
						const firstOptionButton = document.getElementById(`${dropdownId}option0`);
						firstOptionButton?.focus();
					} else {
						const regex = new RegExp(`${dropdownId}option([0-9])`);
						const result = currentElement.id.match(regex);
						if (result?.length) {
							const index = parseInt(result[1]);
							if (index < Object.entries(options).length - 1) {
								const nextOption = document.getElementById(`${dropdownId}option${index + 1}`);
								nextOption?.focus();
							}
						}
					}
					break;

				case KEYCODES.up:
					if (!currentElement?.id || currentElement.id === EXPAND_OPTIONS_BUTTON) {
						const lastIndex = Object.entries(options).length - 1;
						const lastOptionButton = document.getElementById(`${dropdownId}option${lastIndex}`);
						lastOptionButton?.focus();
					} else {
						const regex = new RegExp(`${dropdownId}option([0-9])`);
						const result = currentElement.id.match(regex);
						if (result?.length) {
							const index = parseInt(result[1]);
							if (index > 0) {
								const nextOption = document.getElementById(`${dropdownId}option${index - 1}`);
								nextOption?.focus();
							}
						}
					}
					break;
			}
		}
	};

	const expandButtonClass = Object.entries(options).length === 1 ? 'hidden' : areOptionsVisible ? 'open' : '';

	return (
		<div className="select-container" onKeyDown={onKeyDown}>
			<div className="select-control">
				<Confirm
					dropdownId={dropdownId}
					className={Object.keys(options).length > 1 ? 'select-left' : ''}
					options={options}
					selected={selectedMethod}
					submitAction={submitAction}
					disabled={!!disabled}
				/>
				<div className='split'></div>
				<button id={EXPAND_OPTIONS_BUTTON} className={'select-right ' + expandButtonClass} aria-label='Expand button options' onClick={onClick}>
					{chevronIcon}
				</button>
			</div>
			<div className={areOptionsVisible ? 'options-select' : 'hidden'}>
				{Object.entries(options).map(([method, text], index) => (
					<button id={`${dropdownId}option${index}`} key={method} value={method} onClick={onMethodChange}>
						{text}
					</button>
				))}
			</div>
		</div>
	);
};

function Confirm({
	dropdownId,
	className,
	options,
	selected,
	disabled,
	submitAction,
}: {
	dropdownId: string;
	className: string;
	options: { [key: string]: string };
	selected: string;
	disabled: boolean;
	submitAction: (selected: string) => Promise<void>;
}) {
	const [isBusy, setBusy] = useState(false);

	const onSubmit = async (event: React.FormEvent) => {
		event.preventDefault();

		try {
			setBusy(true);
			await submitAction(selected);
		} finally {
			setBusy(false);
		}
	};

	return (
		<form onSubmit={onSubmit}>
			<input disabled={isBusy || disabled} type="submit" className={className} id={`confirm-button${dropdownId}`} value={options[selected]} />
		</form>
	);
}
