package com.leadup.nova

import android.content.Context
import android.content.res.AssetManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Log
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.KeywordSpotter
import com.k2fsa.sherpa.onnx.KeywordSpotterConfig
import com.k2fsa.sherpa.onnx.OnlineModelConfig
import com.k2fsa.sherpa.onnx.OnlineTransducerModelConfig
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * One installed wake word.
 *
 * `asset` points at a **keywords file**, not a classifier, which is the whole point of
 * this engine: the phrase is text, so it can be changed without training a model.
 */
data class WakeWordModel(
    val name: String,
    val asset: String,
    val threshold: Float,
)

/** A fired wake word. */
data class WakeWordDetection(
    val name: String,
    val score: Float,
)

/**
 * On-device wake-word detection using sherpa-onnx keyword spotting.
 *
 * ## Why this replaces openWakeWord
 *
 * openWakeWord ships a fixed set of pretrained classifiers and there is no "Nova" among
 * them, so the app listened for `hey_jarvis` — a phrase that has nothing to do with the
 * product, and one the companion's name cannot change. Measured on a real OnePlus 9R with
 * a human voice, that classifier scored **0.645** against its 0.5 threshold, where
 * synthesised speech scored 0.99: the model was trained on synthetic speech, so a real
 * voice sits close to the line and fires only sometimes.
 *
 * sherpa-onnx's KWS model is a zipformer transducer whose modelling units are BPE pieces,
 * so a wake word is **data**:
 *
 *     HEY NOVA  ->  ▁HE Y ▁NO V A :2.0
 *
 * Tokenised with the model's own `bpe.model` and written to a keywords file — no training,
 * no account, no access key. Verified off-device at 5/7 speakers with 0/7 false positives
 * against "hey siri", "hey nora", "ok nova" and "nova nova"; the on-device numbers are
 * what this class exists to produce.
 *
 * ## Threading and lifetime
 *
 * Audio is captured on `Dispatchers.Default`; [detections] is emitted from there, and the
 * consumer in [WakeWordService] hops to the main thread before touching Flutter. All
 * model state is owned by this class and released in [release] — the native spotter holds
 * ONNX Runtime memory that a GC will not reclaim.
 */
/**
 * The outcome of one `AudioRecord.read`, reduced to a decision the loop can make without
 * knowing about coroutines or the recorder.
 *
 * Extracted as a top-level type so the busy-spin guard can be tested in a JVM test: the
 * defect it fixes was invisible to the compiler and only showed on a device as 96-121% CPU.
 */
internal sealed interface ReadDecision {
    /** A successful read: process the samples. */
    data object Proceed : ReadDecision

    /** A failed read: wait [backoffMs] and try again. */
    data class Retry(val backoffMs: Long) : ReadDecision

    /** Too many consecutive failures: stop the engine. */
    data object GiveUp : ReadDecision
}

/**
 * Decides how to respond to one read, purely from its result and the running failure count.
 *
 * A read that returned `<= 0` must never become an unbounded retry: that is the busy-spin.
 * The first [SherpaWakeWordEngine.MAX_READ_FAILURES] failures back off, the next one stops
 * the engine.
 */
internal fun decideRead(read: Int, consecutiveFailures: Int): ReadDecision {
    if (read > 0) return ReadDecision.Proceed
    val next = consecutiveFailures + 1
    if (next >= SherpaWakeWordEngine.MAX_READ_FAILURES) return ReadDecision.GiveUp
    return ReadDecision.Retry(SherpaWakeWordEngine.READ_FAILURE_BACKOFF_MS)
}

class SherpaWakeWordEngine(
    context: Context,
    private val models: List<WakeWordModel>,
    private val cooldownMs: Long,
    private val scope: CoroutineScope,
) {
    private val assets: AssetManager = context.applicationContext.assets

    private val _detections = MutableSharedFlow<WakeWordDetection>(extraBufferCapacity = 8)
    val detections: SharedFlow<WakeWordDetection> = _detections.asSharedFlow()

    private var spotter: KeywordSpotter? = null
    private var recorder: AudioRecord? = null
    private var job: Job? = null

    @Volatile private var running = false
    @Volatile private var lastDetectionAt = 0L

    /** Consecutive `AudioRecord.read` failures that returned <= 0. */
    private var consecutiveReadFailures = 0

    /**
     * Loads the model and starts capturing. Throws if the model cannot be created, so the
     * caller can report a real failure rather than a silent no-op.
     */
    fun start() {
        if (running) return

        val keywordsFile = models.firstOrNull()?.asset
            ?: throw IllegalStateException("No wake word installed")

        // `keywordsScore` boosts the phrase above the general vocabulary; `threshold` is
        // the score above which a detection fires. OpenWakeWord's default was 0.5, which
        // a real voice only just cleared; the KWS model is more sensitive and 0.25 is the
        // value the off-device verification measured against.
        val threshold = models.first().threshold

        val config = KeywordSpotterConfig(
            featConfig = FeatureConfig(sampleRate = SAMPLE_RATE, featureDim = FEATURE_DIM),
            modelConfig = OnlineModelConfig(
                transducer = OnlineTransducerModelConfig(
                    encoder = "$MODEL_DIR/encoder.int8.onnx",
                    decoder = "$MODEL_DIR/decoder.int8.onnx",
                    joiner = "$MODEL_DIR/joiner.int8.onnx",
                ),
                tokens = "$MODEL_DIR/tokens.txt",
                // One thread: this runs continuously in a foreground service and must not
                // compete with the UI or the recorder for cores on a mid-range phone.
                numThreads = 1,
                modelType = "zipformer2",
                modelingUnit = "bpe",
                bpeVocab = "$MODEL_DIR/bpe.model",
            ),
            maxActivePaths = 4,
            keywordsFile = keywordsFile,
            keywordsScore = KEYWORD_SCORE,
            keywordsThreshold = threshold,
            numTrailingBlanks = 1,
        )

        // Constructed before the AudioRecord so a model failure does not leave the
        // microphone open.
        val created = KeywordSpotter(assetManager = assets, config = config)
        spotter = created

        val minBuffer = AudioRecord.getMinBufferSize(
            SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        if (minBuffer <= 0) {
            created.release()
            spotter = null
            throw IllegalStateException("AudioRecord does not support 16 kHz mono PCM16")
        }

        // `MIC`, not `VOICE_RECOGNITION`.
        //
        // `VOICE_RECOGNITION` is the usual tuning for a wake word, but it is on the list
        // of call-audio sources in `test/features/call_recording_contract_test.dart`, whose
        // job is to prove this app cannot touch call audio — a store-policy guarantee. The
        // guard failed the moment this file appeared, which is the guard working. A wake
        // word listens to the microphone, so `MIC` is both the accurate choice and the one
        // that leaves the guarantee intact.
        val record = AudioRecord(
            MediaRecorder.AudioSource.MIC,
            SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            minBuffer * 2,
        )
        if (record.state != AudioRecord.STATE_INITIALIZED) {
            record.release()
            created.release()
            spotter = null
            throw IllegalStateException("Could not open the microphone for wake-word listening")
        }
        recorder = record
        running = true

        val stream = created.createStream()
        record.startRecording()

        job = scope.launch(Dispatchers.Default) {
            val buffer = ShortArray(READ_SAMPLES)
            try {
                while (isActive && running) {
                    val read = record.read(buffer, 0, buffer.size)
                    // The decision lives in `decideRead` so the busy-spin guard is testable.
                    // `AudioRecord.read` returns 0 or a negative error code
                    // (ERROR_INVALID_OPERATION, ERROR_BAD_VALUE, ERROR_DEAD_OBJECT) and does
                    // so *immediately*, so `continue`-ing straight back into it pegged a core
                    // — 96-121% CPU with the UI starved on the device, 0% with the engine
                    // stopped. A failure now backs off, and a run of them gives up.
                    when (val decision = decideRead(read, consecutiveReadFailures)) {
                        ReadDecision.Proceed -> consecutiveReadFailures = 0
                        ReadDecision.GiveUp -> {
                            Log.e(TAG, "AudioRecord.read kept failing; stopping the engine")
                            break
                        }
                        is ReadDecision.Retry -> {
                            consecutiveReadFailures += 1
                            if (consecutiveReadFailures == 1 || consecutiveReadFailures % 50 == 0) {
                                Log.w(TAG, "AudioRecord.read returned $read (x$consecutiveReadFailures)")
                            }
                            delay(decision.backoffMs)
                            continue
                        }
                    }

                    val samples = FloatArray(read) { buffer[it] / 32768.0f }
                    // The second argument is the **sample rate**, not the number of
                    // samples. Passing `read` (1600) told sherpa the audio was 1600 Hz and
                    // it built a 1600 -> 16000 resampler, which it logged as
                    // "in_sample_rate: 1600" — the model then never matched anything,
                    // because the features it was computing were of a ten-times
                    // downsampled signal. The build cannot catch this and no unit test
                    // here would either; the device log said it plainly.
                    stream.acceptWaveform(samples, SAMPLE_RATE)

                    // Bounded on purpose: `isReady` is the model's own signal that it has
                    // consumed the available features, but if it ever stayed true this
                    // loop would spin without yielding. The cap is far above what one
                    // 100 ms read can produce, so it never truncates real work.
                    var decodes = 0
                    while (created.isReady(stream) && decodes < MAX_DECODES_PER_READ) {
                        created.decode(stream)
                        decodes += 1
                    }

                    val result = created.getResult(stream)
                    if (result.keyword.isNotEmpty()) {
                        val now = System.currentTimeMillis()
                        if (now - lastDetectionAt >= cooldownMs) {
                            lastDetectionAt = now
                            val name = models.first().name
                            Log.i(TAG, "DETECTION! $name (keyword=${result.keyword})")
                            _detections.tryEmit(WakeWordDetection(name, 1.0f))
                        }
                        // Reset after a hit, and also when the result is non-empty, so a
                        // partial match does not carry into the next utterance.
                        created.reset(stream)
                    }
                }
            } catch (t: Throwable) {
                Log.e(TAG, "Wake-word listening loop stopped", t)
            } finally {
                runCatching { record.stop() }
            }
        }

        Log.i(TAG, "sherpa-onnx KWS started (model=$MODEL_DIR, keywords=$keywordsFile, threshold=$threshold)")
    }

    /** Stops capture. Safe to call when already stopped. */
    fun stop() {
        running = false
        job?.cancel()
        job = null
        runCatching { recorder?.stop() }
        Log.i(TAG, "sherpa-onnx KWS stopped")
    }

    /** Releases native resources. [stop] first, then this. */
    fun release() {
        stop()
        runCatching { recorder?.release() }
        recorder = null
        runCatching { spotter?.release() }
        spotter = null
    }

    companion object {
        const val TAG = "SherpaWakeWord"

        /** The zipformer KWS model is trained on 16 kHz audio. */
        const val SAMPLE_RATE = 16000
        const val FEATURE_DIM = 80

        /** 100 ms per read: fine enough that a short phrase is not split across buffers. */
        const val READ_SAMPLES = 1600

        /**
         * How long to wait before retrying a read that returned `<= 0`.
         *
         * 50 ms is long enough that a persistent error cannot burn a core, and short
         * enough that a transient one costs nothing audible.
         */
        internal const val READ_FAILURE_BACKOFF_MS = 50L

        /** Give up after this many consecutive read failures rather than retrying for ever. */
        internal const val MAX_READ_FAILURES = 500

        /** Upper bound on decode steps drained per read; see the loop comment. */
        const val MAX_DECODES_PER_READ = 64


        /** Phrase boosting. The verification used 2.0; see `tools/wakeword/README.md`. */
        const val KEYWORD_SCORE = 2.0f

        const val MODEL_DIR = "wakeword/kws"
    }
}
