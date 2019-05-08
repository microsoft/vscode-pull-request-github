import * as React from 'react';

import { dateFromNow } from '../src/common/utils';

export const Timestamp = ({
	date,
	href,
}: {
	date: Date | string,
	href: string
}) => <a href={href} className='timestamp'>{dateFromNow(date)}</a>;

export default Timestamp;