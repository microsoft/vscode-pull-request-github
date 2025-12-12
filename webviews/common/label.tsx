/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import React, { ReactNode } from 'react';
import { gitHubLabelColor } from '../../src/common/utils';
import { ILabel } from '../../src/github/interface';

export interface LabelProps {
	label: ILabel & { canDelete: boolean; isDarkTheme: boolean };
}

export function Label(label: ILabel & { canDelete: boolean; isDarkTheme: boolean; children?: ReactNode}) {
	const { name, canDelete, color } = label;
	const labelColor = gitHubLabelColor(color, label.isDarkTheme, false);
	return (
		<div
			className="section-item label"
			style={{
				backgroundColor: labelColor.backgroundColor,
				color: labelColor.textColor,
				borderColor: `${labelColor.borderColor}`,
				paddingRight: canDelete ? '2px' : '8px'
			}}
		>
			{name}{label.children}
		</div>
	);
}

export function LabelCreate(label: ILabel & { canDelete: boolean; isDarkTheme: boolean; children?: ReactNode}) {
	const { name, color } = label;
	const labelColor = gitHubLabelColor(color, label.isDarkTheme, false);
	return (
		<li
		style={{
			backgroundColor: labelColor.backgroundColor,
			color: labelColor.textColor,
			borderColor: `${labelColor.borderColor}`
		}}>
			{name}{label.children}</li>
	);
}
