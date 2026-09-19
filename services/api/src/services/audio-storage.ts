/**
 * NOVA API — object storage for recorded meeting audio.
 *
 * ## Why this exists
 *
 * Master document §4.1 makes meeting transcription **asynchronous**: the client
 * uploads and walks away, and the transcript and summary appear later. That
 * design has a hard consequence — the audio has to outlive the HTTP request
 * that carried it. A pipeline that only ever held the bytes in memory could not
 * be asynchronous at all, and `audio_recordings.storage_key` (NOT NULL, no
 * default) has been carrying a placeholder precisely because nothing wrote a
 * real object.
 *
 * So this module is the missing half: an S3-compatible client for MinIO — the
 * deployment already runs it (`nova-minio`, healthy, with `S3_*` in the API
 * container's environment and a `storage` block in `config.ts`) — and it is the
 * only place that touches object storage.
 *
 * ## What it refuses to do
 *
 * Every operation reports its own failure. There is no "assume it worked"
 * branch: [putAudio] returns the checksum and byte count it actually wrote, and
 * [getAudio] throws [AudioStorageError] when the object is not there. The route
 * layer turns that into a 503 the user can read, because silently marking a
 * recording `uploaded` when MinIO rejected the write would be a lie about the
 * one thing the user cares about — whether their meeting was saved.
 *
 * ## What it deliberately does not claim
 *
 * `storageChecksum` is a SHA-256 of the bytes NOVA received, computed here, not
 * a provider ETag. It proves the object NOVA stored is the object NOVA later
 * read back; it is not an authenticity guarantee about the client's file.
 */
import {
	CreateBucketCommand,
	DeleteObjectCommand,
	GetObjectCommand,
	HeadBucketCommand,
	HeadObjectCommand,
	PutObjectCommand,
	S3Client,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

/** Raised when the object store is unreachable, misconfigured, or missing a key. */
export class AudioStorageError extends Error {
	constructor(
		message: string,
		readonly code: 'unavailable' | 'not_found' | 'too_large' | 'unknown',
		readonly cause?: unknown,
	) {
		super(message);
		this.name = 'AudioStorageError';
	}
}

/**
 * Audio containers NOVA will store, and the extension used for each.
 *
 * The list is closed rather than "anything the client sends": an arbitrary
 * content type would let a caller park a non-audio object under a recording key,
 * and the transcript pipeline would then hand it to a speech provider.
 */
export const AUDIO_CONTENT_TYPES: Record<string, string> = {
	'audio/wav': '.wav',
	'audio/x-wav': '.wav',
	'audio/wave': '.wav',
	'audio/mp4': '.m4a',
	'audio/m4a': '.m4a',
	'audio/x-m4a': '.m4a',
	'audio/aac': '.aac',
	'audio/mpeg': '.mp3',
	'audio/mp3': '.mp3',
	'audio/webm': '.webm',
	'audio/ogg': '.ogg',
	'audio/flac': '.flac',
};

/** Hard ceiling on one uploaded recording, in bytes. */
export const MAX_AUDIO_BYTES = 32 * 1024 * 1024;

/** The container the speech providers are happiest with, used as the fallback. */
export const DEFAULT_AUDIO_CONTENT_TYPE = 'audio/wav';

export interface StorageConfig {
	endpoint: string;
	accessKey: string;
	secretKey: string;
	bucket: string;
	region: string;
}

/**
 * The configured object-store coordinates, or `null` when the deployment has
 * not supplied them.
 *
 * Read lazily through a function — never captured at module load — so an
 * operator (or a test) that sets `S3_ENDPOINT` after import still sees the
 * effect, and so nothing here runs while a unit test is importing the router.
 */
export function storageConfig(): StorageConfig | null {
	const storage = (config as { storage?: Partial<StorageConfig> }).storage;
	if (!storage?.endpoint || !storage.bucket) return null;
	return {
		endpoint: storage.endpoint,
		accessKey: storage.accessKey ?? '',
		secretKey: storage.secretKey ?? '',
		bucket: storage.bucket,
		// MinIO ignores the region but the SDK refuses to sign without one.
		region: (storage as { region?: string }).region ?? 'us-east-1',
	};
}

export function isObjectStorageConfigured(): boolean {
	return storageConfig() !== null;
}

let client: S3Client | null = null;

function getClient(cfg: StorageConfig): S3Client {
	if (client) return client;
	client = new S3Client({
		endpoint: cfg.endpoint,
		region: cfg.region,
		// MinIO serves path-style buckets; virtual-host addressing would resolve
		// `bucket.minio` and fail.
		forcePathStyle: true,
		credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
	});
	return client;
}

/** Test seam: forget the memoised client (used after a config change). */
export function resetAudioStorageClient(): void {
	client = null;
	bucketChecked = false;
}

/**
 * Whether the configured bucket has been confirmed to exist this process.
 *
 * MinIO ships with no buckets at all — a fresh deployment that declares
 * `S3_BUCKET` still has nothing to write into, and the first upload fails with
 * `NoSuchBucket`. Checking once per process (rather than on every put) keeps the
 * cost to a single extra request for the life of the process.
 */
let bucketChecked = false;

/**
 * Confirms the configured bucket exists, creating it when it does not.
 *
 * The API is the only writer on this deployment and `S3_BUCKET` names the
 * bucket it is configured to own, so creating it is provisioning the resource
 * the configuration already promises — not a side effect on someone else's
 * data. A bucket that exists untouched; any error other than 404 propagates so
 * a genuine connectivity or credential failure still reports as itself.
 */
async function ensureBucket(s3: S3Client, cfg: StorageConfig): Promise<void> {
	if (bucketChecked) return;
	try {
		await s3.send(new HeadBucketCommand({ Bucket: cfg.bucket }));
		bucketChecked = true;
		return;
	} catch (err) {
		const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
		if (status !== 404) throw err;
	}
	await s3.send(new CreateBucketCommand({ Bucket: cfg.bucket }));
	bucketChecked = true;
	logger.info({ bucket: cfg.bucket }, 'Created the recording storage bucket');
}

/**
 * The object key for one recording.
 *
 * Scoped by user id as well as recording id so that even a leaked key cannot be
 * walked sideways into another account's audio, and stable across re-uploads of
 * the same recording.
 */
export function buildAudioKey(
	userId: string,
	recordingId: string,
	contentType: string,
): string {
	const extension = AUDIO_CONTENT_TYPES[normaliseContentType(contentType)] ?? '.bin';
	return `recordings/${userId}/${recordingId}${extension}`;
}

/** Drops parameters (`; codecs=…`) and lower-cases, so `Audio/WAV` matches. */
export function normaliseContentType(contentType: string): string {
	return contentType.split(';')[0].trim().toLowerCase();
}

export function isSupportedAudioType(contentType: string): boolean {
	return normaliseContentType(contentType) in AUDIO_CONTENT_TYPES;
}

export interface StoredAudio {
	key: string;
	bytes: number;
	checksum: string;
	contentType: string;
}

export interface AudioStorageCapabilities {
	objectStorage: boolean;
	endpoint: string | null;
	bucket: string | null;
	maxUploadBytes: number;
}

/**
 * The four object-store operations this service performs.
 *
 * Split out so a test can drive the whole pipeline — upload, existence check,
 * read-back — against an in-memory map without an S3 server or a module mock.
 * `routes/recordings.ts` is imported by the shared test bootstrap before any
 * test file runs, so `vi.mock` cannot reach its imports; an explicit,
 * documented seam is both honest and the only thing that works here.
 */
export interface AudioStorageDriver {
	put(key: string, body: Buffer, contentType: string): Promise<StoredAudio>;
	get(key: string): Promise<Buffer>;
	head(key: string): Promise<boolean>;
	remove(key: string): Promise<boolean>;
	capabilities(): AudioStorageCapabilities;
}

// ─── The S3/MinIO driver ────────────────────────────────────────────────────

function s3Capabilities(): AudioStorageCapabilities {
	const cfg = storageConfig();
	return {
		objectStorage: cfg !== null,
		endpoint: cfg?.endpoint ?? null,
		bucket: cfg?.bucket ?? null,
		maxUploadBytes: MAX_AUDIO_BYTES,
	};
}

const s3Driver: AudioStorageDriver = {
	async put(key, body, contentType) {
		const cfg = requireConfig('saved');
		const type = normaliseContentType(contentType);
		const checksum = createHash('sha256').update(body).digest('hex');
		try {
			const s3 = getClient(cfg);
			await ensureBucket(s3, cfg);
			await s3.send(
				new PutObjectCommand({
					Bucket: cfg.bucket,
					Key: key,
					Body: body,
					ContentType: type,
					ContentLength: body.length,
					Metadata: { checksum },
				}),
			);
		} catch (err) {
			logger.error({ err, key, bytes: body.length }, 'Object storage rejected the upload');
			throw new AudioStorageError(
				'The recording could not be saved to storage, so it was not processed.',
				'unavailable',
				err,
			);
		}
		return { key, bytes: body.length, checksum, contentType: type };
	},

	async get(key) {
		const cfg = requireConfig('read');
		try {
			const result = await getClient(cfg).send(
				new GetObjectCommand({ Bucket: cfg.bucket, Key: key }),
			);
			const chunks: Buffer[] = [];
			// The SDK types the body as a streaming mixin; iterate whatever it
			// hands back rather than assuming one concrete class.
			for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
				chunks.push(Buffer.from(chunk));
			}
			return Buffer.concat(chunks);
		} catch (err) {
			const name = (err as { name?: string }).name ?? '';
			if (name === 'NoSuchKey' || name === 'NotFound') {
				throw new AudioStorageError('The stored audio for this recording is missing.', 'not_found', err);
			}
			logger.error({ err, key }, 'Object storage could not read the recording audio');
			throw new AudioStorageError('The stored audio could not be read back.', 'unavailable', err);
		}
	},

	async head(key) {
		const cfg = storageConfig();
		if (!cfg) return false;
		try {
			await getClient(cfg).send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }));
			return true;
		} catch {
			return false;
		}
	},

	async remove(key) {
		const cfg = storageConfig();
		if (!cfg) return false;
		try {
			await getClient(cfg).send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
			return true;
		} catch (err) {
			logger.warn({ err, key }, 'Could not delete stored recording audio');
			return false;
		}
	},

	capabilities: s3Capabilities,
};

function requireConfig(verb: string): StorageConfig {
	const cfg = storageConfig();
	if (!cfg) {
		throw new AudioStorageError(
			`Object storage is not configured on this server, so the audio could not be ${verb}.`,
			'unavailable',
		);
	}
	return cfg;
}

// ─── The active driver ──────────────────────────────────────────────────────

let activeDriver: AudioStorageDriver = s3Driver;

/**
 * Replaces the transport. Pass `null` to restore S3/MinIO.
 *
 * Used by the suite so the upload, existence check and read-back paths can be
 * exercised end to end without an object server.
 */
export function setAudioStorageDriver(driver: AudioStorageDriver | null): void {
	activeDriver = driver ?? s3Driver;
}

// ─── Public surface ─────────────────────────────────────────────────────────

/**
 * Writes one recording's audio and returns what was actually stored.
 *
 * Throws [AudioStorageError] rather than returning a falsy value: the caller
 * must not be able to mistake "the store said no" for "stored". The size rules
 * live here rather than in the driver so every transport enforces them.
 */
export async function putAudio(
	key: string,
	body: Buffer,
	contentType: string,
): Promise<StoredAudio> {
	if (body.length === 0) {
		throw new AudioStorageError('The uploaded audio was empty.', 'unknown');
	}
	if (body.length > MAX_AUDIO_BYTES) {
		throw new AudioStorageError(
			`The recording is larger than the ${Math.floor(MAX_AUDIO_BYTES / (1024 * 1024))} MB limit.`,
			'too_large',
		);
	}

	const stored = await activeDriver.put(key, body, contentType);
	logger.info(
		{ key, bytes: stored.bytes, contentType: stored.contentType },
		'Recording audio stored',
	);
	return stored;
}

/** Reads one recording's audio back. */
export function getAudio(key: string): Promise<Buffer> {
	return activeDriver.get(key);
}

/**
 * Whether an object exists, without downloading it.
 *
 * A driver that fails reports `false`, including an unreachable store: the
 * caller treats "unknown" as "not there", which can only ever refuse work,
 * never fabricate a transcript from nothing.
 */
export function audioExists(key: string): Promise<boolean> {
	return activeDriver.head(key);
}

/** Best-effort delete, for the artefact-cleanup path. Never throws. */
export function deleteAudio(key: string): Promise<boolean> {
	return activeDriver.remove(key);
}

/**
 * What this deployment can honestly claim about recording storage.
 *
 * `objectStorage` is a configuration fact, not a liveness probe — a route that
 * needs the truth calls [audioExists] or [putAudio] and reports what happened.
 * The route layer exposes this so a client can tell "storage is not configured
 * here" from "storage is configured but this upload failed".
 */
export function audioStorageCapabilities(): AudioStorageCapabilities {
	return activeDriver.capabilities();
}
