/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as React from 'react';
import { render } from 'react-dom';
import '../common/common.css';
import './index.css';
import { App } from './app';

function main() {
	render(<App />, document.getElementById('app'));
}

main();

