/**
 * Recording processor — orchestrates transcription, segmentation, and persistence.
 */

import type { TranscriptSegment } from '@nova/shared-types';
import type { RecordingJobData, TranscriptionJobData, SegmentationJobData } from '../queues/types.js';
import { getPool } from '@nova/database';
import { Transcriber } from '@nova/voice';

export interface ProcessingResult {
	segmentsCreated: number;
	transcriptionId: string;
	latencyMs: number;
}

export class RecordingProcessor {
	private readonly transcriber: Transcriber;

	constructor(opts: { transcriber: Transcriber }) {
		this.transcriber = opts.transcriber;
	}

	/**
	 * Full pipeline: fetch recording metadata, transcribe, segment, persist.
	 */
	async process(data: { recordingId: string }): Promise<ProcessingResult> {
		const start = Date.now();
		const recordingId = data.recordingId;

		console.log(`[recording-processor] Starting pipeline for ${recordingId}`);

		// 1. Load recording metadata from database
		const recording = await this.getRecording(recordingId);
		if (!recording) {
			throw new Error(`Recording not found: ${recordingId}`);
		}

		if (recording.status === 'deleted') {
			console.warn(`[recording-processor] Recording ${recordingId} is deleted, skipping`);
			return { segmentsCreated: 0, transcriptionId: '', latencyMs: 0 };
		}

		// 2. Transcribe audio
		const transcription = await this.transcribe(recording);
		const transcriptionId = transcription.id;

		// 3. Segment transcription into structured segments
		const segments = await this.segment(transcription);

		// 4. Persist segments to database
		const segmentsCreated = await this.persistSegments(transcriptionId, segments);

		const latencyMs = Date.now() - start;
		console.log(
			`[recording-processor] Completed ${recordingId}: ${segmentsCreated} segments in ${latencyMs}ms`
		);

		return { segmentsCreated, transcriptionId, latencyMs };
	}

	/**
	 * Enqueue transcription job for async processing.
	 */
	async enqueueTranscription(data: TranscriptionJobData): Promise<string> {
		console.log(`[recording-processor] Enqueueing transcription for ${data.recordingId}`);
		const transcription = await this.transcribeFromData(data);
		return transcription.id;
	}

	/**
	 * Enqueue segmentation job for async processing.
	 */
	async enqueueSegmentation(data: SegmentationJobData): Promise<number> {
		console.log(`[recording-processor] Enqueueing segmentation for transcription ${data.transcriptionId}`);
		const segments = await this.segmentFromData(data);
		return this.persistSegments(data.transcriptionId, segments);
	}

	// ─── Private helpers ────────────────────────────────────────────────────────

	private async getRecording(recordingId: string): Promise<{
		id: string;
		sessionId: string;
		userId: string;
		organizationId: string;
		storageKey: string;
		format: string;
		status: string;
	}> | null {
		const pool = getPool();
		const result = await pool.query(
			'SELECT id, session_id, user_id, organization_id, storage_key, format, status, created_at FROM recordings WHERE id = $1',
			[recordingId]
		);
		return result.rows[0] ?? null;
	}

	private async transcribe(recording: {
		id: string;
		storageKey: string;
	}): Promise<{
		id: string;
		text: string;
		fullText: string;
		segments: TranscriptSegment[];
		language: string;
		latencyMs: number;
	}> {
		const transcriptionResult = await this.transcriber.transcribe({
			audioBuffer: Buffer.from(recording.storageKey),
			contentType: 'audio/webm',
			language: 'en',
			userId: '',
			tenantId: '',
			recordingId: recording.id,
		});

		// Persist transcription
		const pool = getPool();
		const result = await pool.query(
			`INSERT INTO transcriptions (recording_id, text, language, model, segments, duration_ms, created_at)
			 VALUES ($1, $2, $3, $4, $5, $6, NOW()) RETURNING id`,
			[
				recording.id,
				transcriptionResult.fullText,
				transcriptionResult.language,
				'nova-v1',
				JSON.stringify(transcriptionResult.segments),
				transcriptionResult.latencyMs,
			]
		);

		// Update recording status
		await pool.query('UPDATE recordings SET status = $1, updated_at = NOW() WHERE id = $2', [
			'transcribed',
			recording.id,
		]);

		return {
			id: result.rows[0].id,
			text: transcriptionResult.fullText,
			fullText: transcriptionResult.fullText,
			segments: transcriptionResult.segments,
			language: transcriptionResult.language,
			latencyMs: transcriptionResult.latencyMs,
		};
	}

	private async segment(transcription: {
		id: string;
		segments: TranscriptSegment[];
	}): Promise<Array<{ startMs: number; endMs: number; text: string; speaker?: string; confidence?: number }>> {
		return transcription.segments.map((seg) => ({
			startMs: seg.startMs,
			endMs: seg.endMs,
			text: seg.text,
			confidence: seg.confidence ?? null,
		}));
	}

	private async persistSegments(
		transcriptionId: string,
		segments: Array<{ startMs: number; endMs: number; text: string; speaker?: string; confidence?: number }>
	): Promise<number> {
		if (segments.length === 0) return 0;

		const values = segments
			.map(
				(_, i) =>
					`($1, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4}, $${i * 4 + 5}, NOW())`
			)
			.join(', ');

		const params: unknown[] = [transcriptionId];
		for (const seg of segments) {
			params.push(seg.startMs, seg.endMs, seg.text, null);
		}

		const pool = getPool();
		await pool.query(
			`INSERT INTO transcript_segments (transcription_id, start_ms, end_ms, text, speaker_label, created_at) VALUES ${values}`,
			params
		);

		return segments.length;
	}

	private async transcribeFromData(data: TranscriptionJobData): Promise<{ id: string; text: string }> {
		const transcriptionResult = await this.transcriber.transcribe({
			audioBuffer: Buffer.from(''),
			contentType: 'audio/webm',
			language: data.language,
			userId: '',
			tenantId: '',
			recordingId: data.recordingId,
		});

		const pool = getPool();
		const result = await pool.query(
			`INSERT INTO transcriptions (recording_id, text, language, model, segments, duration_ms, created_at)
			 VALUES ($1, $2, $3, $4, $5, $6, NOW()) RETURNING id`,
			[
				data.recordingId,
				transcriptionResult.fullText,
				data.language,
				data.model,
				JSON.stringify(transcriptionResult.segments),
				transcriptionResult.latencyMs,
			]
		);

		return { id: result.rows[0].id, text: transcriptionResult.fullText };
	}

	private async segmentFromData(
		data: SegmentationJobData
	): Promise<Array<{ startMs: number; endMs: number; text: string; speaker?: string; confidence?: number }>> {
		return data.segments.map((seg) => ({
			startMs: seg.start,
			endMs: seg.end,
			text: seg.text,
			speaker: seg.speaker,
			confidence: seg.confidence,
		}));
	}
}
