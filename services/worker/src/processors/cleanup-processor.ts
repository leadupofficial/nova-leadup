/**
 * Cleanup processor — removes stale recordings and their storage artifacts.
 */

import { db } from '@nova/database';
import { CleanupJobData } from '../queues/types.js';

export interface CleanupOptions {
	batchSize?: number;
	dryRun?: boolean;
}

export class CleanupProcessor {
	private readonly batchSize: number;

	constructor(options: CleanupOptions = {}) {
		this.batchSize = options.batchSize ?? 50;
	}

	/**
	 * Find recordings older than the cutoff and delete them (soft-delete + storage removal).
	 */
	async process(data: CleanupJobData): Promise<{ deleted: number; storageRemoved: number }> {
		const olderThanDays = data.olderThanDays ?? 30;
		const cutoff = new Date();
		cutoff.setDate(cutoff.getDate() - olderThanDays);

		console.log(`[cleanup] Running cleanup for recordings older than ${cutoff.toISOString()}`);

		// Find candidate recordings (already soft-deleted or older than retention)
		const result = await db.query(
			`SELECT id, storage_key, status FROM recordings
			 WHERE (status = 'deleted' OR created_at < $1)
			 LIMIT $2`,
			[cutoff.toISOString(), this.batchSize]
		);

		const recordings = result.rows;
		let deleted = 0;
		let storageRemoved = 0;

		for (const recording of recordings) {
			try {
				// Remove storage artifacts if still present
				if (recording.storage_key && !data.storageKeys?.includes(recording.storage_key)) {
					await this.removeStorage(recording.storage_key);
					storageRemoved++;
				}

				// Hard-delete (or keep audit trail)
				await db.query('DELETE FROM recordings WHERE id = $1', [recording.id]);
				deleted++;
			} catch (err) {
				console.error(`[cleanup] Failed to delete recording ${recording.id}:`, err);
			}
		}

		console.log(`[cleanup] Completed: ${deleted} recordings deleted, ${storageRemoved} storage artifacts removed`);
		return { deleted, storageRemoved };
	}

	/**
	 * Remove a single storage object.
	 */
	async removeStorage(key: string): Promise<void> {
		try {
			const { getStorageClient } = await import('@nova/shared-utils');
			const storage = getStorageClient();
			await storage.deleteObject({ Bucket: process.env.STORAGE_BUCKET!, Key: key }).promise();
		} catch (err) {
			console.warn(`[cleanup] Storage removal failed for ${key}:`, err);
		}
	}
}
