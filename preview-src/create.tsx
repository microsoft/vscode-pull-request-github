import { h, render, Component } from 'preact';
import './index.css';

import { setTitle, setBody, pickBranch, setUpstream, setBase, CREATE, getState } from '~/shared/actions';
import { State } from '~/shared/state';

declare var acquireVsCodeApi: any;
const vscode = acquireVsCodeApi();
const send = (action: any) => vscode.postMessage(action);

const main = document.createElement('div');
document.body.appendChild(main);

const input = (createAction: (text: string) => any): JSX.EventHandler<Event> =>
	(e: Event) => {
		const action = createAction((e.target as any).value);
		if (typeof action.type === 'string') { send(action); }
	};

class CreatePR extends Component<any, State> {
	componentDidMount() {
		addEventListener('message', this.onState);
		send(getState);
	}

	componentWillUnmount() {
		removeEventListener('message', this.onState);
	}

	onState = (e: MessageEvent) => this.setState(e.data);

	setTitle = input(setTitle);
	setBody = input(setBody);
	setBranch = input(pickBranch);
	setRemote = input(remote => this.selectedBranch && setUpstream({
		remote, branch: this.selectedBranch
	}));
	setBase = input(index => setBase(!!+index));
	createPR = (e: Event) => {
		e.preventDefault();
		send({type: CREATE});
	}

	get branches() {
		return this.state.localBranches;
	}

	get remotes() {
		return this.state.gitHubRemotes;
	}

	get selectedBranch() {
		return this.state.newPR.spec.branch.name;
	}

	get branchSelector() {
		const {selectedBranch} = this;
		return <select onInput={this.setBranch}>{
			this.branches.map(branch =>
				<option value={branch} selected={branch === selectedBranch}>{branch}</option>
			)
		}</select>;
	}

	get selectedRemote() {
		const {upstream} = this.state.newPR.spec.branch;
		return upstream && upstream.remote;
	}

	get remoteSelector() {
		const {remotes, selectedRemote} = this;
		return <select onInput={this.setRemote}>{
			Object.keys(remotes).map(remote => {
				const {host, owner, name} = remotes[remote];
				return <option value={remote} selected={remote === selectedRemote}>
					{host}/{owner}/{name} ({remote})
				</option>;
			})
		}</select>;
	}

	get bases() {
		const {remotes, selectedRemote} = this;
		if (!remotes || !selectedRemote) { return null; }
		const origin = remotes[selectedRemote].metadata;
		if (!origin) { return null; }
		if (origin.fork) { return [origin, origin.parent]; }
		return [origin];
	}

	get selectedBase() {
		return this.state.newPR.spec.parentIsBase ? 1 : 0;
	}

	get baseSelector() {
		const {bases, selectedBase} = this;
		if (!bases) { return '(select a repo first)'; }
		return <select onInput={this.setBase}>{
			bases.map((base, i) =>
				<option value={i} selected={i === selectedBase}>{
					`${base.owner.login}:${base.default_branch}`
				}</option>)
		}</select>;
	}

	get ready() {
		return this.state.newPR.request;
	}

	public render(_props: any, state: State) {
		if (!state || !state.newPR || !state.newPR.spec) { return null; }
		const {spec} = state.newPR;
		return <form class='create-pr' onSubmit={this.createPR}>
			<h1>Create Pull Request</h1>
			<label>Push branch {this.branchSelector}</label>
			<label> to remote {this.remoteSelector}</label>
			<label> and request a merge into {this.baseSelector}.</label>
			<input class='title'
				onInput={this.setTitle}
				placeholder='Title'
				value={spec.title}
				/>
			<textarea onInput={this.setBody}
				value={spec.body}
				placeholder='Description'/>
			<div class='form-actions'>
				<input
					type='submit' disabled={!this.ready} value='Create PR' />
			</div>
			{/* <pre>{
				JSON.stringify(state, null, 2)
			}</pre> */}
		</form>;
	}
}

render(<CreatePR />, main);