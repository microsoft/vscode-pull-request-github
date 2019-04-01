import * as React from 'react';

import md from './mdRenderer';
const emoji = require('node-emoji');

type MarkdownProps = { src: string } & Record<string, any>;

export const Markdown = ({ src, ...others }: MarkdownProps) =>
	<div dangerouslySetInnerHTML={{ __html: md.render(emoji.emojify(src)) }} {...others} />;

export default Markdown;