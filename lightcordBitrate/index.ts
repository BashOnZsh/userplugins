/*
 * Vencord, a modification for Discord's desktop app
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import { findByPropsLazy, waitFor } from "@webpack";
import { showToast as vencordShowToast, Toasts } from "@webpack/common";

type TransportOptions = Record<string, any> & {
    audioEncoder?: Record<string, any>;
};

const VoiceModule = findByPropsLazy("setLocalVolume", "mergeUsers", "setSelfMute", "setSelfDeaf");
const logger = new Logger("LightcordBitrate");

const OPUS_PROFILE = Object.freeze({
    channels: 2,
    freq: 48000,
    rate: 512000,
    minBitrate: 512000,
    maxBitrate: 512000,
    pacsize: 960,
    application: 2049,
    signal: 3002,
    bandwidth: 1105,
    complexity: 10,
    bitratePriority: 1,
    cbr: true,
    constrained_vbr: false,
    fec: false,
    dtx: false,
    packetLossRate: 0,
    stereoRedundancy: true,
    forceStereo: true
});

const TRANSPORT_PROFILE = Object.freeze({
    encodingVoiceBitRate: 512000,
    encodingBitRate: 512000,
    callBitrate: 512000,
    callMaxBitRate: 512000,
    minBitrate: 512000,
    maxBitrate: 512000,
    packetLossRate: 0,
    fec: false,
    dtx: false,
    cbr: true,
    constrained_vbr: false,
    adaptiveBitrate: false,
    adaptivePtime: false,
    adaptiveAudioPacketLoss: false,
    voiceProcessing: false,
    enableAgc: false,
    enableNS: false,
    enableAEC: false,
    enableDSP: false,
    enableRed: true,
    enableDred: true,
    enableRtx: true,
    forceAudioRedundancy: true,
    forceStereoAudio: true,
    prioritySpeakerDucking: false,
    enableAudioPacing: false
});

const STREAM_VIDEO = Object.freeze({
    maxBitrate: 15000000,
    minBitrate: 10000000,
    targetBitrate: 15000000,
    maxFramerate: 60,
    keyFrameInterval: 2000,
    numTemporalLayers: 1,
    scaleResolutionDownBy: 1,
    degradationPreference: "maintain-resolution",
    priorityBitrate: "maintain-resolution"
});

const STREAM_TRANSPORT = Object.freeze({
    encodingVideoBitRate: 15000000,
    encodingVideoBitrate: 15000000,
    encodingScreenShareBitRate: 15000000,
    screenshareEncodingBitRate: 15000000,
    encodingBitRate: 15000000,
    callBitrate: 15000000,
    callMaxBitRate: 15000000,
    encodingVoiceBitRate: 512000,
    minBitrate: 10000000,
    maxBitrate: 15000000,
    maxFramerate: 60,
    keyFrameInterval: 2000,
    fixedKeyframeInterval: true,
    simulcastEnabled: true,
    cbr: true,
    constrained_vbr: false,
    adaptiveBitrate: false,
    adaptivePtime: false,
    adaptiveAudioPacketLoss: false,
    voiceProcessing: false,
    enableAgc: false,
    enableNS: false,
    enableAEC: false,
    enableDSP: false,
    enableRtx: true,
    prioritySpeakerDucking: false,
    enableAudioPacing: true,
    audioPacketSize: 960,
    audioPacketPacing: 20,
    enableAudioFrameCoalescing: false,
    jitterBufferFastAccelerate: false,
    minAudioJitterBufferPackets: 6,
    maxAudioJitterBufferPackets: 28,
    playoutDelayHint: 24,
    minimumOutputDelay: 20
});

const FIELD_TRIALS: Record<string, string> = Object.freeze({
    'WebRTC-FullBandHpfKillSwitch': 'Enabled',
    'WebRTC-Aec3TransparentModeKillSwitch': 'Enabled',
    'WebRTC-Aec3AntiHowlingMinimizationKillSwitch': 'Enabled',
    'WebRTC-Aec3SubtractorAnalyzerResetKillSwitch': 'Enabled',
    'WebRTC-MutedStateKillSwitch': 'Enabled',
    'WebRTC-AdjustOpusBandwidth': 'Disabled',
    'WebRTC-Audio-Red-For-Opus': 'Enabled',
    'WebRTC-ZeroPlayoutDelay': 'Disabled',
    'WebRTC-Pacer-BlockAudio': 'Disabled',
    'WebRTC-Audio-GainController2': 'Disabled',
    'WebRTC-TransientSuppressorForcedOff': 'Enabled',
    'WebRTC-Audio-NetEqDecisionLogicConfig': 'reinit_after_expands:150',
    'WebRTC-Audio-NetEqPostDecodeTimeStretch': 'Disabled',
    'WebRTC-Audio-NetEqExtraDelay': 'Disabled',
    'WebRTC-Audio-NetEqVarianceBasedExpand': 'Enabled',
    'WebRTC-Audio-NetEqFastAccelerate': 'Disabled',
    'WebRTC-Audio-NetEqMaxBufferSize': '200',
    'WebRTC-Audio-Plc2': 'Enabled',
    'WebRTC-Audio-NetEqIcq': 'Enabled',
    'WebRTC-Audio-OpusGeneratePlc': 'Disabled',
    'WebRTC-Audio-OpusAvoidNoisePumpingDuringDtx': 'Disabled',
    'WebRTC-Audio-OpusSetSignalVoiceWithDtx': 'Disabled',
    'WebRTC-Audio-StableTargetAdaptation': 'Disabled',
    'WebRTC-Audio-ABWENoTWCC': 'Disabled',
    'WebRTC-Audio-NetEqNackTrackerConfig': 'max_loss_rate:0',
    'WebRTC-OpusMaxPlaybackRate': '48000',
    'WebRTC-Audio-OpusMaxBitrate': '512000',
    'WebRTC-Audio-OpusMaxBandwidth': '48000'
});

const STREAM_TRIAL_OVERRIDES: Record<string, string> = Object.freeze({
    'WebRTC-Pacer-PadInSilence': 'Enabled',
    'WebRTC-ElasticBitrateAllocation': 'Disabled',
    'WebRTC-Bwe-LossBasedBweV2': 'Disabled',
    'WebRTC-Audio-StableTargetAdaptation': 'Disabled',
    'WebRTC-VideoMinTransmitBitrate': '10000000',
    'WebRTC-VideoEncoderSettings': 'bitrate:15000000/min:10000000',
    'WebRTC-VideoQualityScalingSettings': 'enabled:false',
    'WebRTC-Video-QualityScaling': 'Disabled',
    'WebRTC-AdjustOpusBandwidth': 'Disabled'
});

export default definePlugin({
    name: "LightcordBitrate",
    description: "Locks high quality Opus transport, stereo fullband audio, and disables exposed voice processing.",
    authors: [{ name: "skenzo", id: 842214916135976981n }],
    tags: ["Voice", "Utility"],

    toastShown: false,
    active: false,
    voiceModule: null as any,
    waitForVoiceModuleRegistered: false,
    watchdog: null as ReturnType<typeof setInterval> | null,
    streamWatchdog: null as ReturnType<typeof setInterval> | null,
    patchedConnections: new Map<any, Function>(),
    originalVoiceMethods: new Map<string, Function>(),
    voiceEngine: null as any,
    streamConnections: new Set<any>(),

    start() {
        this.active = true;
        this.showStartupToast();

        // Try to resolve voice engine (field trials injector) early.
        try {
            this.voiceEngine = findByPropsLazy("updateFieldTrial", "createVoiceConnectionWithOptions", "VoiceConnection");
            if (this.voiceEngine) { this.patchAudioProcessing(this.voiceEngine); this.injectVoice(this.voiceEngine); }
        } catch {
            this.voiceEngine = null;
        }

        if (this.voiceModule) {
            this.installVoiceHooks(this.voiceModule);
        } else if (!this.waitForVoiceModuleRegistered) {
            this.waitForVoiceModuleRegistered = true;
            waitFor(["setLocalVolume", "mergeUsers", "setSelfMute", "setSelfDeaf"], module => {
                if (!this.active) return;

                this.voiceModule = module;
                this.installVoiceHooks(module);
            }, { isIndirect: true });
        }

        this.startWatchdog();
    },

    stop() {
        this.active = false;
        this.stopWatchdog();

        for (const [connection, originalSetTransportOptions] of this.patchedConnections.entries()) {
            try {
                connection.setTransportOptions = originalSetTransportOptions;
            } catch {
                // Ignore restoration failures.
            }
        }

        this.patchedConnections.clear();
        this.streamConnections.clear();
        this.uninstallVoiceHooks();
        this.toastShown = false;
        this.voiceEngine = null;

        logger.info("Stopped and restored patched connections.");
    },

    showToast(message: string, type = Toasts.Type.SUCCESS) {
        vencordShowToast(message, type, { duration: 7000 });
    },

    showStartupToast() {
        if (this.toastShown) return;

        this.toastShown = true;
        this.showToast("[ADEM] Clear filterless audio active: 512kbps CBR, stereo fullband, DSP off when exposed.");
    },

    safeCall(target: any, method: string, ...args: any[]) {
        try {
            if (target && typeof target[method] === "function") {
                target[method](...args);
            }
        } catch {
            // Best effort only.
        }
    },

    injectTrials(engine: any, map: Record<string, string>) {
        if (!engine || typeof engine.updateFieldTrial !== "function") return;
        for (const [trial, value] of Object.entries(map)) {
            try { engine.updateFieldTrial(trial, value); } catch { }
        }
    },

    injectVoice(engine: any) {
        this.injectTrials(engine, FIELD_TRIALS);
    },

    injectStream(engine: any) {
        this.injectTrials(engine, FIELD_TRIALS);
        this.injectTrials(engine, STREAM_TRIAL_OVERRIDES);
    },

    injectStreamOverrides(engine: any) {
        this.injectTrials(engine, STREAM_TRIAL_OVERRIDES);
    },

    isStream(options: any) {
        if (!options || typeof options !== 'object') return false;
        return !!(options.videoEncoder != null || options.encodingVideoBitRate != null || options.encodingVideoBitrate != null || options.screenshare || options.goLive || options.simulcastEncodings || options.videoHook != null || options.keyFrameInterval != null || options.fixedKeyframeInterval || (options.maxFramerate != null && options.audioEncoder == null) || options.soundshareActive || options.videoActive);
    },

    buildStreamOptions(options: TransportOptions = {}) {
        const base = options && typeof options === 'object' ? options : {};
        const patched: any = {
            ...base,
            ...STREAM_TRANSPORT,
            videoEncoder: { ...(base as any).videoEncoder || {}, ...STREAM_VIDEO },
            audioEncoder: { ...(base as any).audioEncoder || {}, ...OPUS_PROFILE }
        };

        if (Array.isArray((base as any).simulcastEncodings)) {
            patched.simulcastEncodings = (base as any).simulcastEncodings.map((layer: any, index: number) => {
                const item = layer && typeof layer === 'object' ? layer : {};
                const max = 15000000 - index * 1000000;
                const min = Math.max(10000000 - index * 1500000, 3500000);
                return { ...item, maxBitrate: Math.max(item.maxBitrate || 0, max), minBitrate: Math.max(item.minBitrate || 0, min), targetBitrate: Math.max(item.targetBitrate || 0, max), maxFramerate: Math.max(item.maxFramerate || 0, 60), scaleResolutionDownBy: item.scaleResolutionDownBy ?? 1 };
            });
        }

        return patched;
    },

    patchAudioProcessing(target: any) {
        if (!target || target.__ADEM_FILTERLESS_DSP__) return;

        try {
            Object.defineProperty(target, "__ADEM_FILTERLESS_DSP__", {
                value: true,
                configurable: true,
                enumerable: false
            });
        } catch {
            // Ignore if the target is not extensible.
        }

        const offMethods = [
            "setAutomaticGainControl",
            "setNoiseSuppression",
            "setEchoCancellation",
            "setEchoCancellationPreEcho",
            "setExperimentalEchoCancellation",
            "setExperimentalNs",
            "setTypingNoiseDetection",
            "setHighPassFilter",
            "setBeamforming",
            "setTransientSuppression",
            "setVoiceProcessing",
            "setGainControl",
            "setAnalogAgc",
            "setResidualEchoDetector",
            "setDelayAgnostic",
            "setIntelligibilityEnhancer",
            "setMultiChannelCaptureProcessing",
            "setLimiter",
            "setEchoCancellationMobileMode"
        ];

        for (const method of offMethods) {
            this.safeCall(target, method, false);
        }

        this.safeCall(target, "setAutomaticGainControlConfig", {
            targetLevel: 0,
            compressionGain: 0,
            limiterEnabled: false
        });

        this.safeCall(target, "setCodecPreferences", ["multiopus", "opus", "red"]);
        this.safeCall(target, "setMinimumOutputDelay", 20);
        this.safeCall(target, "setPlayoutDelayHint", 20);
    },

    buildTransportOptions(options: TransportOptions = {}) {
        const base = options && typeof options === "object" ? options : {};

        return {
            ...base,
            ...TRANSPORT_PROFILE,
            audioEncoder: {
                ...(base.audioEncoder || {}),
                ...OPUS_PROFILE
            }
        };
    },

    patchConnection(connection: any) {
        if (!connection || typeof connection.setTransportOptions !== "function") return;

        if (this.patchedConnections.has(connection)) {
            this.patchAudioProcessing(connection);
            if (this.voiceEngine) {
                if (this.streamConnections.has(connection)) this.injectStreamOverrides(this.voiceEngine);
                else this.injectVoice(this.voiceEngine);
            }
            const original = this.patchedConnections.get(connection);
            if (original) { try { original.call(connection, this.streamConnections.has(connection) ? this.buildStreamOptions({}) : this.buildTransportOptions({})); } catch { } }
            return;
        }

        const originalSetTransportOptions = connection.setTransportOptions.bind(connection);
        this.patchedConnections.set(connection, originalSetTransportOptions);

        connection.setTransportOptions = (options: TransportOptions = {}) => {
            const stream = this.isStream(options) || this.streamConnections.has(connection);
            if (stream) this.streamConnections.add(connection);
            this.patchAudioProcessing(connection);
            return originalSetTransportOptions(stream ? this.buildStreamOptions(options) : this.buildTransportOptions(options));
        };

        this.patchAudioProcessing(connection);

        try { connection.setMinimumOutputDelay?.(20); } catch {}
        try { connection.setPlayoutDelayHint?.(20); } catch {}
        try { connection.setLoopbackPlaybackGainMultiplier?.(1.0); } catch {}
        try { connection.setCodecPreferences?.(["multiopus", "opus", "red"]); } catch {}

        try {
            originalSetTransportOptions(this.buildTransportOptions({}));
        } catch {
            // Some connections only accept transport updates once they are live.
        }

        logger.info("Filterless transport patched.");
    },

    patchVoiceInstance(instance: any) {
        if (!instance) return;

        this.patchAudioProcessing(instance);
        if (instance.conn) this.patchConnection(instance.conn);
    },

    installVoiceHooks(voiceModule: any) {
        const prototype = voiceModule?.prototype;
        if (!prototype) {
            this.showToast("[ADEM] Voice module not found. Join a voice channel, then reload Vencord.", Toasts.Type.FAILURE);
            logger.error("Voice module not found.");
            return;
        }

        const plugin = this;
        const patchMethods = ["setLocalVolume", "mergeUsers", "setSelfMute", "setSelfDeaf", "setLocalMute"];
        for (const method of patchMethods) {
            if (typeof prototype[method] !== "function") continue;
            if (this.originalVoiceMethods.has(method)) continue;

            const originalMethod = prototype[method];
            this.originalVoiceMethods.set(method, originalMethod);

            prototype[method] = function (this: any, ...args: any[]) {
                plugin.patchVoiceInstance(this);
                return Reflect.apply(originalMethod, this, args);
            };
        }

        logger.info("Vencord hooks installed.");
    },

    uninstallVoiceHooks() {
        if (!this.voiceModule?.prototype) return;

        const prototype = this.voiceModule.prototype;
        for (const [method, originalMethod] of this.originalVoiceMethods.entries()) {
            try {
                prototype[method] = originalMethod;
            } catch {
                // Ignore restoration failures.
            }
        }

        this.originalVoiceMethods.clear();
    },

    startWatchdog() {
        this.stopWatchdog();

        this.watchdog = setInterval(() => {
            try {
                if (this.voiceEngine) { this.patchAudioProcessing(this.voiceEngine); this.injectVoice(this.voiceEngine); }
                for (const [connection] of this.patchedConnections) {
                    try { this.patchAudioProcessing(connection); } catch (_) { this.patchedConnections.delete(connection); }
                }
            } catch (_) {}
        }, 15000);

        this.streamWatchdog = setInterval(() => {
            try {
                for (const connection of Array.from(this.streamConnections)) {
                    if (!this.patchedConnections.has(connection)) { this.streamConnections.delete(connection); continue; }
                    try {
                        if (this.voiceEngine) this.injectStreamOverrides(this.voiceEngine);
                        this.patchAudioProcessing(connection);
                    } catch (_) { this.streamConnections.delete(connection); }
                }
            } catch (_) {}
        }, 10000);
    },

    stopWatchdog() {
        if (this.watchdog) {
            clearInterval(this.watchdog);
            this.watchdog = null;
        }
        if (this.streamWatchdog) {
            clearInterval(this.streamWatchdog);
            this.streamWatchdog = null;
        }
    }
});
