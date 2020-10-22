/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { useState } from 'react'
import { chevronIcon } from './icon';

const enum KEYCODES {
	esc = 27,
	down = 40,
	up = 38
}

export const Dropdown = ({ options, defaultOption, submitAction }) => {
	const [selectedMethod, selectMethod] = useState<string>(defaultOption);
	const [areOptionsVisible, setOptionsVisible] = useState<boolean>(false);

	const EXPAND_OPTIONS_BUTTON = 'expandOptions';

	const onClick = e => {
		setOptionsVisible(!areOptionsVisible);
	}

	const onMethodChange = e => {
		selectMethod(e.target.value);
		setOptionsVisible(false);
		const primaryButton = document.getElementById('confirm-button');
		primaryButton.focus();
	}

	const onKeyDown = e => {
		if (e.keyCode === KEYCODES.esc && areOptionsVisible) {
			setOptionsVisible(false);
			const expandOptionsButton = document.getElementById(EXPAND_OPTIONS_BUTTON);
			expandOptionsButton.focus();
		}

		if (e.keyCode === KEYCODES.down && areOptionsVisible) {
			const currentElement = document.activeElement;
			if (!currentElement.id || currentElement.id === EXPAND_OPTIONS_BUTTON) {
				const firstOptionButton = document.getElementById('option0');
				firstOptionButton.focus();
			} else {
				const result = currentElement.id.match(/option([0-9])/);
				if (result.length) {
					const index = parseInt(result[1]);
					if (index < Object.entries(options).length - 1) {
						const nextOption = document.getElementById(`option${index + 1}`);
						nextOption.focus();
					}
				}
			}
		}

		if (e.keyCode === KEYCODES.up && areOptionsVisible) {
			const currentElement = document.activeElement;
			if (!currentElement.id || currentElement.id === EXPAND_OPTIONS_BUTTON) {
				const lastIndex = Object.entries(options).length;
				const lastOptionButton = document.getElementById(`option${lastIndex}`);
				lastOptionButton.focus();
			} else {
				const result = currentElement.id.match(/option([0-9])/);
				if (result.length) {
					const index = parseInt(result[1]);
					if (index > 0) {
						const nextOption = document.getElementById(`option${index - 1}`);
						nextOption.focus();
					}
				}
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
			<Confirm options={options} selected={selectedMethod} submitAction={submitAction} />
			<button id={EXPAND_OPTIONS_BUTTON} className={expandButtonClass} onClick={onClick}>{chevronIcon}</button>
		</div>
		<div className={areOptionsVisible ? 'options-select' : 'hidden'}>
			{
				Object.entries(options)
					.map(([method, text], index) =>
						<button id={`option${index}`} key={method} value={method} onClick={onMethodChange}>
							{text}
						</button>
					)
			}
		</div>
	</div>;
}

function Confirm({ options, selected, submitAction }: { options: { [key: string]: string }, selected: string, submitAction: (selected: string) => Promise<void> }) {

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
		<input disabled={isBusy} type='submit' id='confirm-button' value={options[selected]} />
	</form>;
}