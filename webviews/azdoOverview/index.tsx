/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'azure-devops-ui/Core/override.css';
import '../common/common.css';
import '../editorWebview/index.css';
import './index.css';
import React from 'react';
import { render } from 'react-dom';
import { App } from './app';
import { watchTheme } from './theme';

addEventListener('load', () => {
	watchTheme();
	render(<App />, document.getElementById('app'));
});
