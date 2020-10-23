/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { useState } from 'react'
import uuid = require('uuid');
import { chevronIcon } from './icon';

const enum KEYCODES {
	esc = 27,
	down = 40,
	up = 38
}

export const Dropdown = ({ options, defaultOption, submitAction }) => {
	const [selectedMethod, selectMethod] = useState<string>(defaultOption);
	const [areOptionsVisible, setOptionsVisible] = useState<boolean>(false);

	const dropdownId = uuid();
	const EXPAND_OPTIONS_BUTTON = `expandOptions${dropdownId}`;

	const onClick = e => {
		setOptionsVisible(!areOptionsVisible);
	}

	const onMethodChange = e => {
		selectMethod(e.target.value);
		setOptionsVisible(false);
		const primaryButton = document.getElementById(`confirm-button${dropdownId}`);
		primaryButton.focus();
	}

	const onKeyDown = e => {
		if (areOptionsVisible) {
			const currentElement = document.activeElement;

			switch (e.keyCode) {
				case KEYCODES.esc:
					setOptionsVisible(false);
					const expandOptionsButton = document.getElementById(EXPAND_OPTIONS_BUTTON);
					expandOptionsButton.focus();
					break

				case KEYCODES.down:
					if (!currentElement.id || currentElement.id === EXPAND_OPTIONS_BUTTON) {
						const firstOptionButton = document.getElementById(`${dropdownId}option0`);
						firstOptionButton.focus();
					} else {
						const regex = new RegExp(`${dropdownId}option([0-9])`)
						const result = currentElement.id.match(regex);
						if (result.length) {
							const index = parseInt(result[1]);
							if (index < Object.entries(options).length - 1) {
								const nextOption = document.getElementById(`${dropdownId}option${index + 1}`);
								nextOption.focus();
							}
						}
					}
					break;

				case KEYCODES.up:
					if (!currentElement.id || currentElement.id === EXPAND_OPTIONS_BUTTON) {
						const lastIndex = Object.entries(options).length - 1;
						const lastOptionButton = document.getElementById(`${dropdownId}option${lastIndex}`);
						lastOptionButton.focus();
					} else {
						const regex = new RegExp(`${dropdownId}option([0-9])`)
						const result = currentElement.id.match(regex);
						if (result.length) {
							const index = parseInt(result[1]);
							if (index > 0) {
								const nextOption = document.getElementById(`${dropdownId}option${index - 1}`);
								nextOption.focus();
							}
						}
					}
					break;
			}
		}
	}

	const expandButtonClass = Object.entries(options).length === 1
		? 'hidden'
		: areOptionsVisible
			? 'open'
			: '';

	return <div className='select-container' onKeyDown={onKeyDown}>
		<div className='select-control'>
			<Confirm dropdownId={dropdownId} options={options} selected={selectedMethod} submitAction={submitAction} />
			<button id={EXPAND_OPTIONS_BUTTON} className={expandButtonClass} onClick={onClick}>{chevronIcon}</button>
		</div>
		<div className={areOptionsVisible ? 'options-select' : 'hidden'}>
			{
				Object.entries(options)
					.map(([method, text], index) =>
						<button id={`${dropdownId}option${index}`} key={method} value={method} onClick={onMethodChange}>
							{text}
						</button>
					)
			}
		</div>
	</div>;
}

function Confirm({ dropdownId, options, selected, submitAction }: { dropdownId: string, options: { [key: string]: string }, selected: string, submitAction: (selected: string) => Promise<void> }) {

	const [isBusy, setBusy] = useState(false);

	const onSubmit = async (event: React.FormEvent) => {
		event.preventDefault();

		try {
			setBusy(true);
			await submitAction(selected);
		} finally {
			setBusy(false);
		}
	}

	return <form onSubmit={onSubmit}>
		<input disabled={isBusy} type='submit' id={`confirm-button${dropdownId}`} value={options[selected]} />
	</form>;
}