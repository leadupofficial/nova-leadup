import { Router } from 'express';
import { isUrlSafe } from '../utils/ssrf-guard.js';

const router: ReturnType<typeof Router> = Router();

/**
 * POST /api/v1/stt/transcribe
 * Proxy to ElevenLabs or Sarvam for speech-to-text.
 * Body: { audio (base64 or url), provider?: 'elevenlabs' | 'sarvam', language?: string }
 */
router.post('/transcribe', async (req, res) => {
	try {
		const { provider = 'elevenlabs', language = 'en', audio } = req.body;

		if (!audio) {
			return res.status(400).json({ error: 'audio is required' });
		}

		const selectedProvider = process.env.ELEVENLABS_API_KEY
			? 'elevenlabs'
			: process.env.SARVAM_API_KEY
				? 'sarvam'
				: provider;

		if (selectedProvider === 'elevenlabs' && process.env.ELEVENLABS_API_KEY) {
			let audioBuffer: Buffer;

			if (audio.startsWith('http')) {
				const urlCheck = isUrlSafe(audio);
				if (!urlCheck.safe) {
					return res.status(400).json({ error: 'INVALID_AUDIO_URL', message: urlCheck.reason });
				}
				const response = await fetch(audio);
				if (!response.ok) {
					throw new Error(`Failed to fetch audio from URL: ${response.status}`);
				}
				audioBuffer = Buffer.from(await response.arrayBuffer());
			} else {
				audioBuffer = Buffer.from(audio, 'base64');
			}

			const response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
				method: 'POST',
				headers: {
					'xi-api-key': process.env.ELEVENLABS_API_KEY,
					'Content-Type': 'audio/mpeg',
				},
				body: audioBuffer,
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`ElevenLabs STT failed: ${response.status} ${errorText}`);
			}

			const result = await response.json() as { text: string; language?: string; confidence?: number };

			return res.json({
				transcript: result.text,
				language: language,
				confidence: result.confidence,
				provider: 'elevenlabs',
			});
		}

		if (selectedProvider === 'sarvam' && process.env.SARVAM_API_KEY) {
			let audioBuffer: Buffer;

			if (audio.startsWith('http')) {
				const urlCheck = isUrlSafe(audio);
				if (!urlCheck.safe) {
					return res.status(400).json({ error: 'INVALID_AUDIO_URL', message: urlCheck.reason });
				}
				const response = await fetch(audio);
				if (!response.ok) {
					throw new Error(`Failed to fetch audio from URL: ${response.status}`);
				}
				audioBuffer = Buffer.from(await response.arrayBuffer());
			} else {
				audioBuffer = Buffer.from(audio, 'base64');
			}

			const formData = new FormData();
			formData.append('file', new Blob([audioBuffer], { type: 'audio/wav' }));
			formData.append('language_code', language === 'ta' ? 'ta-IN' : 'en-IN');

			const response = await fetch('https://api.sarvam.ai/speech-to-text', {
				method: 'POST',
				headers: {
					'api-subscription-key': process.env.SARVAM_API_KEY,
				},
				body: formData as unknown as BodyInit,
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`Sarvam STT failed: ${response.status} ${errorText}`);
			}

			const result = await response.json() as { transcript: string };

			return res.json({
				transcript: result.transcript,
				language: language,
				confidence: 0.95,
				provider: 'sarvam',
			});
		}

		res.status(503).json({
			error: 'NO_STT_PROVIDER',
			message: 'No STT provider configured for this request',
		});
	} catch (error) {
		console.error('[VoiceAPI] STT error:', error);
		res.status(500).json({
			error: 'STT_FAILED',
			message: error instanceof Error ? error.message : 'Unknown error',
		});
	}
});

export { router as sttRoutes };
