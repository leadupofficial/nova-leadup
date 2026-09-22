import { Router } from 'express';

const router: ReturnType<typeof Router> = Router();

/**
 * POST /api/v1/tts/synthesize
 * Proxy to ElevenLabs or Sarvam for text-to-speech.
 * Body: { text, voiceId?, provider?: 'elevenlabs' | 'sarvam', language?: string }
 */
router.post('/synthesize', async (req, res) => {
	try {
		const { text, voiceId, provider = 'elevenlabs', language = 'en' } = req.body;

		if (!text || typeof text !== 'string') {
			return res.status(400).json({ error: 'text is required' });
		}

		const selectedProvider = process.env.ELEVENLABS_API_KEY
			? 'elevenlabs'
			: process.env.SARVAM_API_KEY
				? 'sarvam'
				: provider;

		if (selectedProvider === 'elevenlabs' && process.env.ELEVENLABS_API_KEY) {
			const response = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + (voiceId || '21m00Tcm4TlvDq8ikWAM'), {
				method: 'POST',
				headers: {
					'xi-api-key': process.env.ELEVENLABS_API_KEY,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					text,
					model_id: 'eleven_multilingual_v2',
					voice_settings: { stability: 0.5, similarity_boost: 0.75 },
				}),
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`ElevenLabs TTS failed: ${response.status} ${errorText}`);
			}

			const audioBuffer = Buffer.from(await response.arrayBuffer());

			res.setHeader('Content-Type', 'audio/mpeg');
			res.setHeader('X-Visemes', JSON.stringify([]));
			res.send(audioBuffer);
			return;
		}

		if (selectedProvider === 'sarvam' && process.env.SARVAM_API_KEY) {
			const response = await fetch('https://api.sarvam.ai/text-to-speech', {
				method: 'POST',
				headers: {
					'api-subscription-key': process.env.SARVAM_API_KEY,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					text,
					language_code: language === 'ta' ? 'ta-IN' : 'en-IN',
					voice_id: voiceId ?? 'meera',
					speed: 1.0,
				}),
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`Sarvam TTS failed: ${response.status} ${errorText}`);
			}

			const audioBuffer = Buffer.from(await response.arrayBuffer());

			res.setHeader('Content-Type', 'audio/mpeg');
			res.setHeader('X-Visemes', JSON.stringify([]));
			res.send(audioBuffer);
			return;
		}

		res.status(503).json({
			provider: selectedProvider,
			voiceId: voiceId ?? 'default',
			language,
			error: 'NO_TTS_PROVIDER',
			message: 'No TTS provider configured for this request',
		});
	} catch (error) {
		console.error('[VoiceAPI] TTS error:', error);
		res.status(500).json({
			error: 'TTS_FAILED',
			message: error instanceof Error ? error.message : 'Unknown error',
		});
	}
});

export { router as ttsRoutes };
