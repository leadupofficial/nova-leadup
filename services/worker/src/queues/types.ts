/**
 * Job types processed by the worker.
 */

export interface RecordingJobData {
	recordingId: string;
	sessionId: string;
	userId: string;
	organizationId: string;
	storageKey: string;
	format: 'webm' | 'mp4' | 'wav' | 'ogg';
	createdAt: string;
}

export interface TranscriptionJobData {
	recordingId: string;
	audioUrl: string;
	language: string;
	model: string;
	speakerCount?: number;
}

export interface SegmentationJobData {
	transcriptionId: string;
	recordingId: string;
	segments: Array<{
		start: number;
		end: number;
		text: string;
		speaker?: string;
		confidence?: number;
	}>;
}

export interface NotificationJobData {
	userId: string;
	organizationId: string;
	type: string;
	payload: Record<string, unknown>;
	priority: 'low' | 'normal' | 'high';
}

export interface CleanupJobData {
	recordingId: string;
	storageKeys: string[];
	olderThanDays?: number;
}

export type JobData =
	| RecordingJobData
	| TranscriptionJobData
	| SegmentationJobData
	| NotificationJobData
	| CleanupJobData;

export const QUEUE_NAMES = {
	recordings: 'recording-processing',
	transcriptions: 'transcription-processing',
	segmentation: 'segmentation-processing',
	notifications: 'notification-processing',
	cleanup: 'cleanup-processing',
} as const;
