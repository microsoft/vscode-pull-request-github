import { SET_REPOSITORY } from '~/shared/actions';

import { RefType } from '~/src/typings/git';
import { Action } from '../handler';

export default (state: string[] = [], { type, repository }: Action): string[] =>
	type === SET_REPOSITORY
		? repository.state.refs
			.filter(r => r.type === RefType.Head && r.name)
			.map(r => r.name)
		: state;
