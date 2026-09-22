import { Router } from 'express';

const router: ReturnType<typeof Router> = Router();

/**
 * POST /api/v1/visemes/generate
 * Generate viseme data from text for lip-sync animation.
 * Body: { text, phonemes?: boolean, fps?: number }
 */
router.post('/generate', async (req, res) => {
	try {
		const { text, phonemes = false, fps = 24 } = req.body;

		if (!text || typeof text !== 'string') {
			return res.status(400).json({ error: 'text is required' });
		}

		const visemes = await generateVisemes(text, { phonemes, fps });

		res.json({
			text,
			phonemes,
			fps,
			visemes,
			duration: visemes.length > 0 ? visemes[visemes.length - 1].time + visemes[visemes.length - 1].duration : 0,
		});
	} catch (error) {
		console.error('[VoiceAPI] Viseme generation error:', error);
		res.status(500).json({
			error: 'VISEME_GENERATION_FAILED',
			message: error instanceof Error ? error.message : 'Unknown error',
		});
	}
});

interface VisemeRequest {
	text: string;
	phonemes: boolean;
	fps: number;
}

interface Viseme {
	time: number;
	duration: number;
	shape: string;
	phoneme?: string;
}

async function generateVisemes(text: string, options: VisemeRequest): Promise<Viseme[]> {
	const normalized = text.trim();

	if (normalized.length === 0) {
		return [];
	}

	const visemes: Viseme[] = [];
	const words = normalized.split(/\s+/).filter((word) => word.length > 0);
	const avgWordDuration = 0.3;
	const avgVisemeDuration = avgWordDuration / 5;
	const startOffset = 0.1;

	let currentTime = startOffset;

	for (const word of words) {
		const wordDuration = Math.max(0.1, word.length * 0.05);
		const visemeCount = Math.max(1, Math.min(word.length, 10));
		const visemeDuration = wordDuration / visemeCount;

		for (let i = 0; i < visemeCount; i++) {
			visemes.push({
				time: currentTime,
				duration: visemeDuration,
				shape: mapPhonemeToViseme(word[i] ?? 'a'),
				...(options.phonemes && { phoneme: word[i] }),
			});
			currentTime += visemeDuration;
		}

		currentTime += 0.05;
	}

	return visemes;
}

function mapPhonemeToViseme(character: string): string {
	const lower = character.toLowerCase();

	if ('aeiou'.includes(lower)) {
		return 'A';
	}

	if ('pb'.includes(lower)) {
		return 'E';
	}

	if ('fv'.includes(lower)) {
		return 'F';
	}

	if ('m'.includes(lower)) {
		return 'M';
	}

	if ('th'.includes(lower)) {
		return 'TH';
	}

	if ('l'.includes(lower)) {
		return 'L';
	}

	if ('wr'.includes(lower)) {
		return 'W';
	}

	return 'Rest';
}

export { router as visemeRoutes };
