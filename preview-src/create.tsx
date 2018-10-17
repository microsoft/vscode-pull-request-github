import {h, render, Component} from 'preact';
import './index.css';

import {setTitle, setBody, pickBranch, setUpstream, setBase, CREATE} from '~/shared/actions';
import {State} from '~/shared/state';

declare var acquireVsCodeApi: any;
const vscode = acquireVsCodeApi();
const send = (action: any) => vscode.postMessage(action);

const main = document.createElement('div');
document.body.appendChild(main);

const input = (createAction: (text: string) => any): JSX.EventHandler<Event> =>
	(e: Event) => send(createAction((e.target as any).value));

class CreatePR extends Component<any, State> {
	componentDidMount() {
		addEventListener('message', this.onState);
	}

	componentWillUnmount() {
		removeEventListener('message', this.onState);
	}

	onState = (e: MessageEvent) => this.setState(e.data as State);

	setTitle = input(setTitle);
	setBody = input(setBody);
	setBranch = input(pickBranch);
	setRemote = input(remote => setUpstream({
		remote, branch: this.selectedBranch
	}));
	setBase = input(index => setBase(!!+index));
	createPR = (e: Event) => {
		e.preventDefault();
		send({type: CREATE});
	}

	get branches() {
		return this.state.spec.localBranches;
	}

	get remotes() {
		return this.state.spec.gitHubRemotes;
	}

	get selectedBranch() {
		return this.state.spec.selectedLocalBranch.name;
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
		const {upstream} = this.state.spec.selectedLocalBranch;
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
		return this.state.spec.parentIsBase ? 1 : 0;
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
		return this.state.willCreatePR;
	}

	public render(_props: any, state: State) {
		if (!state || !state.spec) { return null; }
		return <form class='create-pr' onSubmit={this.createPR}>
			<h1>Create Pull Request</h1>
			<label>Push branch {this.branchSelector}</label>
			<label> to remote {this.remoteSelector}</label>
			<label> and request a merge into {this.baseSelector}.</label>
			<input class='title'
				onInput={this.setTitle}
				placeholder='Title'
				value={state.spec.title}
				/>
			<textarea onInput={this.setBody}
				value={state.spec.body}
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