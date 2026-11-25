/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useState } from 'react';
import { v4 as uuid } from 'uuid';
import { chevronDownIcon } from './icon';
import { useBusyAction } from '../common/hooks';

const enum KEYCODES {
	esc = 27,
	down = 40,
	up = 38,
}

export const Dropdown = ({ options, defaultOption, disabled, busyLabel, submitAction, changeAction }: { options: { [key: string]: string }, defaultOption: string, disabled?: boolean, busyLabel?: string, submitAction: (string) => Promise<void>, changeAction?: (string) => Promise<void> }) => {
	const [selectedMethod, selectMethod] = useState<string>(defaultOption);
	const [areOptionsVisible, setOptionsVisible] = useState<boolean>(false);
	const [isBusy, run] = useBusyAction();

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

	const hasMultipleOptions = Object.entries(options).length > 1;
	const expandButtonClass = !hasMultipleOptions ? 'hidden' : areOptionsVisible ? 'open' : '';
	const isDisabled = isBusy || !!disabled;

	const onSubmit = (event: React.FormEvent) => {
		event.preventDefault();
		return run(() => submitAction(selectedMethod));
	};

	return (
		<div className="select-container" onKeyDown={onKeyDown}>
			<div className="select-control">
				<form onSubmit={onSubmit}>
					<input disabled={isDisabled} type="submit" className={hasMultipleOptions ? 'select-left' : ''} id={`confirm-button${dropdownId}`}
						value={isBusy && busyLabel ? busyLabel : options[selectedMethod]} />
				</form>
				{hasMultipleOptions ? <div className={`split${isDisabled ? ' disabled' : ''}`}><div className={`separator${isDisabled ? ' disabled' : ''}`}></div></div> : null}
				<button id={EXPAND_OPTIONS_BUTTON} className={'select-right ' + expandButtonClass} aria-label='Expand button options' disabled={isBusy} onClick={onClick}>
					{chevronDownIcon}
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
