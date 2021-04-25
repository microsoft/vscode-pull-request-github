import { ViewedState } from '../common/comment';
import { LocalStorageService } from '../common/localStorageService';

export interface PRFileViewedState {
	changed: FileViewedStatus[];
}

export interface FileViewedStatus {
	fileSHA: string;
	viewed: ViewedState;
}

export class FileReviewedStatusService {
	/**
	 *
	 */
	constructor(private _localStorageService: LocalStorageService) {}

	getFileReviewedStatusForPr(prId: number): PRFileViewedState {
		return this._localStorageService.getValue<PRFileViewedState>(`${prId}.fileReviewStatus`, { changed: [] });
	}

	setFileReviewedStatusForPr(prId: number, fileViewedStatus: FileViewedStatus) {
		const existing = this.getFileReviewedStatusForPr(prId);
		this._localStorageService.setValue<PRFileViewedState>(`${prId}.fileReviewStatus`, {
			changed: [...existing.changed.filter(f => f.fileSHA !== fileViewedStatus.fileSHA), fileViewedStatus],
		});
	}
}
