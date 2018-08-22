/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//@ts-check

const path = require('path');
const webpack = require('webpack');

/** @type webpack.Configuration */
const webview = {
	name: 'webiew',
	entry: {
		index: './preview-src/index.ts'
	},
	module: {
		rules: [
			{
				test: /\.tsx?$/,
				use: 'ts-loader',
				exclude: /node_modules/
			},
			{
				test: /\.css/,
				use: ['style-loader', 'css-loader']
			}
		]
	},
	resolve: {
		extensions: ['.tsx', '.ts', '.js']
	},
	devtool: 'inline-source-map',
	output: {
		filename: '[name].js',
		path: path.resolve(__dirname, 'media')
	}
};

/** @type webpack.Configuration */
const extension = {
	name: 'extension',
	target: 'node',
	entry: {
		extension: './src/extension.ts'
	},
	module: {
		rules: [
			{
				test: /\.tsx?$/,
				use: 'ts-loader',
				exclude: /node_modules/
			}
		]
	},
	resolve: {
		extensions: ['.tsx', '.ts', '.js'],
		alias: {
			"node-fetch": path.resolve(__dirname, 'node_modules/node-fetch/lib/index.js'),
		}
	},
	devtool: 'source-map',
	output: {
		filename: '[name].js',
		path: path.resolve(__dirname, 'media'),
		libraryTarget: "commonjs",
		devtoolModuleFilenameTemplate: 'file:///[absolute-resource-path]'
	},
	externals: {
		'vscode': 'commonjs vscode',
		'utf-8-validate': 'utf-8-validate',
		'bufferutil': 'bufferutil',
		'encoding': 'encoding'
	},
};

module.exports = [webview, extension];