/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';

export class Resource {
	static icons: any;

	static initialize(context: vscode.ExtensionContext) {
		Resource.icons = {
			reactions: {
				THUMBS_UP: context.asAbsolutePath(path.join('resources', 'icons', 'reactions', 'thumbs_up.png')),
				THUMBS_DOWN: context.asAbsolutePath(path.join('resources', 'icons', 'reactions', 'thumbs_down.png')),
				CONFUSED: context.asAbsolutePath(path.join('resources', 'icons', 'reactions', 'confused.png')),
				EYES: context.asAbsolutePath(path.join('resources', 'icons', 'reactions', 'eyes.png')),
				HEART: context.asAbsolutePath(path.join('resources', 'icons', 'reactions', 'heart.png')),
				HOORAY: context.asAbsolutePath(path.join('resources', 'icons', 'reactions', 'hooray.png')),
				LAUGH: context.asAbsolutePath(path.join('resources', 'icons', 'reactions', 'laugh.png')),
				ROCKET: context.asAbsolutePath(path.join('resources', 'icons', 'reactions', 'rocket.png')),
			}
		};
	}
}
