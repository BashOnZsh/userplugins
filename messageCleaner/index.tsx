/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelStore, GuildStore, Menu, RestAPI, UserStore } from "@webpack/common";
import { Channel, Guild,Message } from "discord-types/general";

const SEARCH_PAGE_SIZE = 25;
const MAX_SEARCH_OFFSET = 4975;
const COMPLETED_SESSION_TTL_MS = 15 * 60 * 1000;

function log(message: string, level: "info" | "warn" | "error" = "info") {
    const timestamp = new Date().toLocaleTimeString();
    const prefix = `[MessageCleaner ${timestamp}]`;

    switch (level) {
        case "warn":
            console.warn(prefix, message);
            break;
        case "error":
            console.error(prefix, message);
            break;
        default:
            console.log(prefix, message);
    }
}

function debugLog(message: string) {
    if (settings.store.debugMode) {
        log(`🔍 ${message}`, "info");
    }
}

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function jitter(ms: number) {
    return Math.random() * ms;
}

function flattenGuildChannels(container: any): any[] {
    if (!container) return [];
    if (Array.isArray(container)) return container;

    if (Array.isArray(container.SELECTABLE)) {
        return container.SELECTABLE.map((entry: any) => entry?.channel ?? entry).filter(Boolean);
    }

    if (Array.isArray(container.channels)) {
        return container.channels.map((entry: any) => entry?.channel ?? entry).filter(Boolean);
    }

    if (typeof container === "object") {
        return Object.values(container).map((entry: any) => entry?.channel ?? entry).filter(Boolean);
    }

    return [];
}

function getGuildTextChannels(guildId: string): any[] {
    const cs: any = ChannelStore;

    let channels: any[] = [];

    if (typeof cs.getChannelIds === "function") {
        const ids = cs.getChannelIds(guildId);
        if (Array.isArray(ids)) {
            channels = ids.map((id: string) => ChannelStore.getChannel(id)).filter(Boolean);
        }
    }

    if (channels.length === 0 && typeof cs.getMutableGuildChannels === "function") {
        channels = flattenGuildChannels(cs.getMutableGuildChannels(guildId));
    }

    if (channels.length === 0 && typeof cs.getGuildChannels === "function") {
        channels = flattenGuildChannels(cs.getGuildChannels(guildId));
    }

    if (channels.length === 0 && typeof cs.getAllChannels === "function") {
        channels = flattenGuildChannels(cs.getAllChannels()).filter((ch: any) => ch.guild_id === guildId);
    }

    if (channels.length === 0 && cs.channels) {
        channels = flattenGuildChannels(cs.channels).filter((ch: any) => ch.guild_id === guildId);
    }

    if (channels.length === 0) {
        log(`Impossible de récupérer la liste des salons. Méthodes dispo: ${Object.keys(cs).join(", ")}`, "error");
    }

    return channels.filter((ch: any) => ch.type === 0 || ch.type === 5);
}

type CleanupScope = "guild" | "channel";
type CleanupPhase = "collect" | "delete" | "done";
type CleanupStatus = "running" | "completed" | "stopped" | "error";

interface SessionStats {
    total: number;
    deleted: number;
    failed: number;
    skipped: number;
    startTime: number;
    endTime: number;
}

interface CleaningSession {
    scope: CleanupScope;
    targetId: string;
    guildId: string;
    userId: string;
    name: string;
    phase: CleanupPhase;
    status: CleanupStatus;
    shouldStop: boolean;
    progressLabel: string;
    stats: SessionStats;
}

function createSession(scope: CleanupScope, targetId: string, guildId: string, userId: string, name: string): CleaningSession {
    return {
        scope,
        targetId,
        guildId,
        userId,
        name,
        phase: "collect",
        status: "running",
        shouldStop: false,
        progressLabel: "",
        stats: {
            total: 0,
            deleted: 0,
            failed: 0,
            skipped: 0,
            startTime: Date.now(),
            endTime: 0
        }
    };
}

const sessions = new Map<string, CleaningSession>();

function pruneOldSessions() {
    const cutoff = Date.now() - COMPLETED_SESSION_TTL_MS;
    for (const [key, session] of sessions) {
        if (session.status !== "running" && session.stats.endTime > 0 && session.stats.endTime < cutoff) {
            sessions.delete(key);
        }
    }
}

function getSession(targetId: string) {
    pruneOldSessions();
    return sessions.get(targetId);
}

function getRunningSession(targetId: string) {
    const session = getSession(targetId);
    return session && session.status === "running" ? session : undefined;
}

function countRunningSessions(excludeTargetId?: string) {
    let count = 0;
    for (const session of sessions.values()) {
        if (session.status === "running" && session.targetId !== excludeTargetId) count++;
    }
    return count;
}

function stopSession(targetId: string) {
    const session = getRunningSession(targetId);
    if (session) {
        session.shouldStop = true;
        log(`⏹️ [${session.name}] Arrêt du nettoyage demandé`);
    }
}

function stopAllSessions() {
    let stopped = 0;
    for (const session of sessions.values()) {
        if (session.status === "running") {
            session.shouldStop = true;
            stopped++;
        }
    }
    if (stopped > 0) {
        log(`⏹️ Arrêt de ${stopped} nettoyage(s) demandé`);
    }
}

let globalPausedUntil = 0;

class RateLimiter {
    currentDelay: number;
    private lastRequestAt = 0;
    private pausedUntil = 0;
    private successStreak = 0;

    constructor(
        private readonly label: string,
        private readonly getBaseDelay: () => number,
        private readonly minDelay: number,
        private readonly maxDelay: number
    ) {
        this.currentDelay = -1;
    }

    private ensureInitialized() {
        if (this.currentDelay < 0) {
            this.currentDelay = Math.min(this.maxDelay, Math.max(this.minDelay, this.getBaseDelay()));
        }
    }

    async acquire() {
        this.ensureInitialized();
        const now = Date.now();
        const earliest = Math.max(this.lastRequestAt + this.currentDelay, this.pausedUntil, globalPausedUntil);
        const waitMs = earliest - now;
        if (waitMs > 0) {
            await sleep(waitMs + jitter(waitMs > 200 ? 120 : 40));
        }
        this.lastRequestAt = Date.now();
    }

    onSuccess() {
        this.ensureInitialized();
        this.successStreak++;
        if (!settings.store.adaptiveSpeed || this.successStreak < 8) return;
        this.successStreak = 0;
        const next = Math.max(this.minDelay, Math.floor(this.currentDelay * 0.8));
        if (next !== this.currentDelay) {
            this.currentDelay = next;
            debugLog(`${this.label}: délai réduit à ${this.currentDelay}ms`);
        }
    }

    onRateLimit(retryAfterMs: number | null, isGlobal: boolean) {
        this.successStreak = 0;
        this.ensureInitialized();
        const base = this.getBaseDelay();
        this.currentDelay = Math.min(this.maxDelay, Math.max(base * 2, Math.ceil(this.currentDelay * 2)));
        const waitMs = Math.min(this.maxDelay, retryAfterMs ?? this.currentDelay);
        this.pausedUntil = Date.now() + waitMs + jitter(250) + 250;
        if (isGlobal) {
            globalPausedUntil = Math.max(globalPausedUntil, this.pausedUntil);
            log(`⛔ Rate limit GLOBAL Discord détecté. Pause commune de ${Math.round((this.pausedUntil - Date.now()) / 1000)}s...`, "warn");
        } else {
            log(`⚠️ Rate limit sur « ${this.label} ». Pause de ${Math.round(waitMs / 1000)}s, délai porté à ${(this.currentDelay / 1000).toFixed(1)}s.`, "warn");
        }
    }
}

const settings = definePluginSettings({
    delayBetweenDeletes: {
        type: OptionType.SLIDER,
        description: "Délai de base entre deux suppressions (ms), ajusté automatiquement en cas de rate limit",
        default: 1000,
        markers: [250, 500, 1000, 2000, 5000],
        minValue: 100,
        maxValue: 10000,
        stickToMarkers: false
    },
    searchDelay: {
        type: OptionType.SLIDER,
        description: "Délai entre deux requêtes de recherche Discord (ms)",
        default: 2000,
        markers: [1000, 2000, 3000, 5000],
        minValue: 1000,
        maxValue: 10000,
        stickToMarkers: false
    },
    fetchDelay: {
        type: OptionType.SLIDER,
        description: "Délai entre deux pages d'historique (ms)",
        default: 500,
        markers: [200, 500, 1000, 2000],
        minValue: 200,
        maxValue: 5000,
        stickToMarkers: false
    },
    batchSize: {
        type: OptionType.SLIDER,
        description: "Messages par page d'historique (max 100)",
        default: 100,
        markers: [25, 50, 100],
        minValue: 25,
        maxValue: 100,
        stickToMarkers: true
    },
    adaptiveSpeed: {
        type: OptionType.BOOLEAN,
        description: "Accélération adaptative : réduit les délais quand aucune erreur n'est détectée",
        default: true
    },
    maxRetries: {
        type: OptionType.SLIDER,
        description: "Tentatives maximum par requête en cas d'erreur transitoire",
        default: 3,
        markers: [1, 2, 3, 5],
        minValue: 1,
        maxValue: 6,
        stickToMarkers: true
    },
    maxConcurrentCleanups: {
        type: OptionType.SLIDER,
        description: "Nombre maximum de nettoyages simultanés",
        default: 2,
        markers: [1, 2, 3, 4],
        minValue: 1,
        maxValue: 5,
        stickToMarkers: true
    },
    channelScanMode: {
        type: OptionType.SELECT,
        description: "Méthode de collecte des messages pour un canal",
        options: [
            { label: "Historique du canal (rapide, évite le rate limit de recherche)", value: "history", default: true },
            { label: "Recherche indexée Discord", value: "search" }
        ]
    },
    guildFallbackScan: {
        type: OptionType.BOOLEAN,
        description: "Secours serveur : si la recherche échoue ou sature, parcourir chaque salon texte (plus lent mais complet)",
        default: false
    },
    showProgress: {
        type: OptionType.BOOLEAN,
        description: "Afficher les rapports de progression dans la console",
        default: true
    },
    debugMode: {
        type: OptionType.BOOLEAN,
        description: "Mode débogage (logs détaillés)",
        default: false
    },
    skipSystemMessages: {
        type: OptionType.BOOLEAN,
        description: "Ignorer les messages système (rejoindre/quitter, etc.)",
        default: true
    },
    skipReplies: {
        type: OptionType.BOOLEAN,
        description: "Ignorer les réponses aux messages",
        default: false
    },
    maxAge: {
        type: OptionType.SLIDER,
        description: "Age maximum des messages à supprimer (jours, 0 = pas de limite)",
        default: 0,
        markers: [0, 1, 7, 30, 90],
        minValue: 0,
        maxValue: 365,
        stickToMarkers: false
    }
});

const deleteLimiter = new RateLimiter(
    "Suppression",
    () => settings.store.delayBetweenDeletes,
    350,
    30000
);

const searchLimiter = new RateLimiter(
    "Recherche",
    () => Math.max(settings.store.searchDelay, 1000),
    1000,
    60000
);

const fetchLimiter = new RateLimiter(
    "Récupération d'historique",
    () => settings.store.fetchDelay,
    250,
    20000
);

function extractRetryAfterMs(error: any): number | null {
    const raw = error?.body?.retry_after ?? error?.body?.retryAfter ?? error?.retry_after ?? error?.retryAfter;
    if (raw === undefined || raw === null) return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return null;
    return value < 1000 ? Math.ceil(value * 1000) : value;
}

function isGlobalRateLimitError(error: any): boolean {
    return !!(error?.body?.global ?? error?.global);
}

function getStatusCode(error: any): number | undefined {
    return error?.status ?? error?.statusCode;
}

function isTransientError(error: any): boolean {
    const statusCode = getStatusCode(error);
    if (statusCode !== undefined) return statusCode >= 500;
    const message = String(error?.message ?? error ?? "").toLowerCase();
    return message.includes("network") || message.includes("failed to fetch") || message.includes("timeout");
}

async function withRetries<T>(
    limiter: RateLimiter,
    operation: () => Promise<T>,
    contextLabel: string
): Promise<T | null> {
    const { maxRetries } = settings.store;
    for (let attempt = 1; ; attempt++) {
        await limiter.acquire();
        try {
            const result = await operation();
            limiter.onSuccess();
            return result;
        } catch (error: any) {
            const statusCode = getStatusCode(error);

            if (statusCode === 429) {
                limiter.onRateLimit(extractRetryAfterMs(error), isGlobalRateLimitError(error));
                if (attempt >= maxRetries) {
                    log(`❌ Abandon (${contextLabel}) après ${maxRetries} tentatives suite au rate limit`, "warn");
                    return null;
                }
                debugLog(`${contextLabel}: nouvelle tentative ${attempt + 1}/${maxRetries} après rate limit`);
                continue;
            }

            if (isTransientError(error) && attempt < maxRetries) {
                const backoff = Math.min(15000, 1000 * 2 ** (attempt - 1)) + jitter(500);
                log(`⚠️ Erreur transitoire (${statusCode ?? "réseau"}) sur « ${contextLabel} ». Nouvelle tentative dans ${Math.round(backoff / 1000)}s (${attempt}/${maxRetries})`, "warn");
                await sleep(backoff);
                continue;
            }

            throw error;
        }
    }
}

function canDeleteMessage(message: Message, currentUserId: string): boolean {
    try {
        if (message.author?.id !== currentUserId) {
            debugLog(`Message ${message.id}: pas votre message (${message.author?.id} != ${currentUserId})`);
            return false;
        }

        if (settings.store.skipSystemMessages) {
            const allowedTypes = [0, 19, 20];
            if (!allowedTypes.includes(message.type)) {
                debugLog(`Message ${message.id}: message système (type ${message.type})`);
                return false;
            }
        }

        const isReply = message.type === 19 || !!message.messageReference || !!(message as any).message_reference;
        if (isReply && settings.store.skipReplies) {
            debugLog(`Message ${message.id}: réponse ignorée (skipReplies=true)`);
            return false;
        }

        if (settings.store.maxAge > 0) {
            let messageTime: number;

            if (typeof message.timestamp === "string") {
                messageTime = new Date(message.timestamp).getTime();
            } else if (message.timestamp && typeof message.timestamp === "object" && "toISOString" in message.timestamp) {
                messageTime = new Date(message.timestamp.toISOString()).getTime();
            } else if (typeof message.timestamp === "number") {
                messageTime = message.timestamp;
            } else {
                return false;
            }

            if (!Number.isFinite(messageTime) || messageTime <= 0) return false;

            const maxAgeMs = settings.store.maxAge * 24 * 60 * 60 * 1000;
            if (Date.now() - messageTime > maxAgeMs) {
                debugLog(`Message ${message.id}: trop ancien`);
                return false;
            }
        }

        return true;
    } catch (error) {
        debugLog(`Erreur de vérification du message ${message.id}: ${error}`);
        return false;
    }
}

async function deleteMessage(channelId: string, messageId: string): Promise<boolean> {
    try {
        const result = await withRetries(
            deleteLimiter,
            () => RestAPI.del({ url: `/channels/${channelId}/messages/${messageId}` }),
            `suppression du message ${messageId}`
        );
        if (result === null) return false;
        debugLog(`✅ Message ${messageId} supprimé`);
        return true;
    } catch (error: any) {
        const statusCode = getStatusCode(error);

        if (statusCode === 404) {
            debugLog(`Message ${messageId} déjà supprimé`);
            return true;
        }
        if (statusCode === 403 || statusCode === 400) {
            debugLog(`Suppression impossible du message ${messageId} (${statusCode})`);
            return false;
        }

        log(`❌ Erreur (${statusCode ?? "inconnue"}) en supprimant le message ${messageId}: ${error?.message ?? error}`, "error");
        return false;
    }
}

async function fetchMessagesPage(channelId: string, beforeId?: string): Promise<Message[] | null> {
    const limit = Math.min(100, Math.max(1, settings.store.batchSize));
    const url = `/channels/${channelId}/messages?limit=${limit}${beforeId ? `&before=${beforeId}` : ""}`;
    const response = await withRetries(
        fetchLimiter,
        () => RestAPI.get({ url }),
        `récupération de l'historique du canal ${channelId}`
    );
    if (response === null) return null;
    const body: any = response?.body;
    return Array.isArray(body) ? body : [];
}

async function searchMessagesPage(
    scope: CleanupScope,
    targetId: string,
    userId: string,
    offset: number
): Promise<{ messages: Message[]; total: number } | null> {
    const base = scope === "guild" ? `/guilds/${targetId}` : `/channels/${targetId}`;
    const url = `${base}/messages/search?author_id=${userId}&include_nsfw=true&offset=${offset}`;
    const response = await withRetries(
        searchLimiter,
        () => RestAPI.get({ url }),
        `recherche ${scope === "guild" ? "serveur" : "canal"} (offset ${offset})`
    );
    if (response === null) return null;

    const body: any = response?.body;
    const rawMessages = Array.isArray(body?.messages) ? body.messages : [];
    const total = body?.total_results ?? 0;

    const flattened: Message[] = [];
    for (const entry of rawMessages) {
        if (Array.isArray(entry)) {
            const hit = entry.find((m: any) => m?.hit)
                ?? entry.find((m: any) => m?.author?.id === userId)
                ?? entry[0];
            if (hit) flattened.push(hit);
        } else if (entry) {
            flattened.push(entry);
        }
    }

    debugLog(`Recherche ${scope}: ${flattened.length} message(s) reçu(s) pour l'offset ${offset}`);
    return { messages: flattened, total };
}

interface CollectResult {
    collected: Message[];
    aborted: boolean;
}

async function collectViaChannelHistory(session: CleaningSession, channelId: string): Promise<CollectResult> {
    const collected: Message[] = [];
    const pageSize = Math.min(100, Math.max(1, settings.store.batchSize));
    let cursor: string | undefined;
    let pages = 0;

    while (!session.shouldStop) {
        const page = await fetchMessagesPage(channelId, cursor);
        if (page === null) {
            log(`❌ [${session.name}] Collecte interrompue dans le canal ${channelId} (erreurs répétées)`, "warn");
            return { collected, aborted: true };
        }
        if (page.length === 0) break;

        for (const msg of page) {
            if (msg.author?.id === session.userId) {
                (msg as any).channel_id = channelId;
                collected.push(msg);
            }
        }

        pages++;
        session.stats.total = collected.length;
        session.progressLabel = `${collected.length} message(s) trouvé(s) sur ${pages * pageSize} parcourus`;

        const oldest = page[page.length - 1]?.id;
        if (!oldest || page.length < pageSize) break;
        cursor = oldest;
    }

    return { collected, aborted: false };
}

interface SearchCollectResult extends CollectResult {
    hitHardCap: boolean;
}

async function collectViaSearch(session: CleaningSession, scope: CleanupScope, targetId: string): Promise<SearchCollectResult> {
    const collected: Message[] = [];
    const seen = new Set<string>();
    let offset = 0;
    let totalResults = Number.POSITIVE_INFINITY;
    let firstPage = true;

    while (!session.shouldStop && offset <= MAX_SEARCH_OFFSET && offset < totalResults) {
        const page = await searchMessagesPage(scope, targetId, session.userId, offset);
        if (page === null) {
            return { collected, aborted: true, hitHardCap: false };
        }

        if (firstPage) {
            totalResults = page.total;
            firstPage = false;
            log(`📊 [${session.name}] Messages indexés: ${totalResults}`);
        }

        let freshCount = 0;
        for (const msg of page.messages) {
            if (seen.has(msg.id)) continue;
            seen.add(msg.id);
            collected.push(msg);
            freshCount++;
        }

        session.stats.total = collected.length;
        session.progressLabel = `${collected.length}/${totalResults} message(s) récupéré(s)`;

        if (freshCount === 0) break;
        offset += SEARCH_PAGE_SIZE;
    }

    const hitHardCap = offset > MAX_SEARCH_OFFSET && offset < totalResults;
    if (hitHardCap) {
        log(`⚠️ [${session.name}] Limite de l'API de recherche atteinte (${MAX_SEARCH_OFFSET + SEARCH_PAGE_SIZE} résultats max). Les messages plus anciens sont inaccessibles par recherche.`, "warn");
    }

    return { collected, aborted: false, hitHardCap };
}

async function collectGuildMessages(session: CleaningSession, guildId: string): Promise<CollectResult> {
    const primary = await collectViaSearch(session, "guild", guildId);
    if (primary.aborted || session.shouldStop || !primary.hitHardCap || !settings.store.guildFallbackScan) {
        return { collected: primary.collected, aborted: primary.aborted };
    }

    log(`🧭 [${session.name}] Mode secours : parcours salon par salon...`);
    const seen = new Set(primary.collected.map(msg => msg.id));
    const channels = getGuildTextChannels(guildId);

    for (let index = 0; index < channels.length; index++) {
        if (session.shouldStop) break;
        const channel = channels[index];
        session.progressLabel = `Salon ${index + 1}/${channels.length}: #${channel.name ?? channel.id}`;

        const result = await collectViaChannelHistory(session, channel.id);
        if (result.aborted) {
            return { collected: primary.collected, aborted: true };
        }
        for (const msg of result.collected) {
            if (!seen.has(msg.id)) {
                seen.add(msg.id);
                primary.collected.push(msg);
            }
        }
        session.stats.total = primary.collected.length;
    }

    return { collected: primary.collected, aborted: false };
}

function formatDuration(ms: number): string {
    if (ms < 60000) return `${Math.round(ms / 1000)}s`;
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.round((ms % 60000) / 1000);
    return `${minutes}min ${seconds}s`;
}

function estimateEtaSeconds(session: CleaningSession): number | null {
    const { total, deleted, failed, startTime, endTime } = session.stats;
    if (endTime > 0 || total === 0) return null;
    const processed = deleted + failed;
    if (processed === 0) return null;
    const rate = processed / ((Date.now() - startTime) / 1000);
    if (rate <= 0) return null;
    return Math.max(1, Math.round((total - processed) / rate));
}

function formatStatusLabel(session: CleaningSession): string {
    if (session.phase === "collect") {
        return `🔍 Collecte... ${session.progressLabel}`;
    }
    if (session.phase === "delete") {
        const { total, deleted, failed } = session.stats;
        const processed = deleted + failed;
        const percentage = total > 0 ? Math.round((processed / total) * 100) : 0;
        const eta = estimateEtaSeconds(session);
        const etaStr = eta !== null ? ` • ~${eta < 60 ? `${eta}s` : `${Math.round(eta / 60)}min`}` : "";
        return `🔄 ${percentage}% (${processed}/${total}) ✅${deleted} ❌${failed}${etaStr}`;
    }
    return `📄 ${session.status}`;
}

function logProgress(session: CleaningSession) {
    if (!settings.store.showProgress) return;
    const { total, deleted, failed } = session.stats;
    const processed = deleted + failed;
    const percentage = total > 0 ? Math.round((processed / total) * 100) : 0;
    log(`⏳ [${session.name}] ${percentage}% (${processed}/${total}) • ✅ ${deleted} • ❌ ${failed}`);
}

async function runCleanupSession(session: CleaningSession, collect: () => Promise<CollectResult>) {
    try {
        log(`🚀 [${session.name}] Démarrage du nettoyage`);
        const { collected, aborted } = await collect();

        if (aborted) {
            session.status = session.shouldStop ? "stopped" : "error";
            if (!session.shouldStop) {
                log(`❌ [${session.name}] Collecte abandonnée suite à des erreurs répétées`, "error");
            }
            return;
        }
        if (session.shouldStop) {
            session.status = "stopped";
            return;
        }

        const uniqueMessages = Array.from(new Map(collected.map(msg => [msg.id, msg])).values());
        const validMessages = uniqueMessages.filter(msg => canDeleteMessage(msg, session.userId));
        session.stats.skipped += uniqueMessages.length - validMessages.length;
        session.stats.total = validMessages.length;

        if (validMessages.length === 0) {
            session.status = "completed";
            log(`✨ [${session.name}] Aucun message supprimable trouvé`);
            return;
        }

        log(`🧹 [${session.name}] Suppression de ${validMessages.length} message(s)...`);
        session.phase = "delete";

        for (const msg of validMessages) {
            if (session.shouldStop) break;

            const channelId = msg.channel_id ?? session.targetId;
            const success = await deleteMessage(channelId, msg.id);
            if (success) {
                session.stats.deleted++;
            } else {
                session.stats.failed++;
            }

            const processed = session.stats.deleted + session.stats.failed;
            if (processed % 25 === 0) logProgress(session);
        }

        session.status = session.shouldStop ? "stopped" : "completed";
    } catch (error) {
        session.status = "error";
        log(`❌ [${session.name}] Erreur pendant le nettoyage: ${error}`, "error");
    } finally {
        session.phase = "done";
        session.stats.endTime = Date.now();
        const { deleted, failed, skipped, startTime, endTime } = session.stats;
        const duration = formatDuration(Math.max(1, endTime - startTime));
        const successRate = deleted + failed > 0 ? Math.round((deleted / (deleted + failed)) * 100) : 100;
        log(`📊 [${session.name}] ${session.status === "stopped" ? "Arrêté" : session.status === "error" ? "Terminé avec erreurs" : "Terminé"} : ✅ ${deleted} supprimé(s), ❌ ${failed} échec(s), ⏭️ ${skipped} ignoré(s), ⏱️ ${duration}, taux de succès ${successRate}%`);
    }
}

function canStartNewSession(targetId: string): boolean {
    pruneOldSessions();
    if (getRunningSession(targetId)) {
        log("Un nettoyage est déjà en cours pour cette cible", "warn");
        return false;
    }
    const running = countRunningSessions();
    const maxConcurrent = settings.store.maxConcurrentCleanups;
    if (running >= maxConcurrent) {
        log(`⚠️ Limite de ${maxConcurrent} nettoyage(s) simultané(s) atteinte. Arrêtez un nettoyage en cours ou augmentez la limite dans les paramètres.`, "warn");
        return false;
    }
    return true;
}

function launchSession(session: CleaningSession, collect: () => Promise<CollectResult>) {
    sessions.set(session.targetId, session);
    void runCleanupSession(session, collect);
}

function getChannelDisplayName(channel: any): string {
    return channel.name
        ?? channel.recipients?.map((id: string) => UserStore.getUser(id)?.username ?? "Utilisateur inconnu").join(", ")
        ?? "Canal privé";
}

function cleanChannel(channelId: string) {
    if (!canStartNewSession(channelId)) return;

    const channel: any = ChannelStore.getChannel(channelId);
    const currentUserId = UserStore.getCurrentUser()?.id;
    if (!channel) {
        log("Canal introuvable", "error");
        return;
    }
    if (!currentUserId) {
        log("Impossible d'obtenir l'ID de l'utilisateur actuel", "error");
        return;
    }

    const guildId: string = channel.guild_id ?? "@me";
    const displayName = getChannelDisplayName(channel);
    const useSearch = settings.store.channelScanMode === "search" && !!channel.guild_id;
    const scopeLabel = guildId === "@me" ? "DM" : `#${displayName}`;

    const session = createSession(
        "channel",
        channelId,
        guildId,
        currentUserId,
        `canal ${scopeLabel}`
    );

    debugLog(`Nettoyage du canal ${channelId}: mode=${useSearch ? "recherche" : "historique"}, délai=${settings.store.delayBetweenDeletes}ms`);

    const collect = () => useSearch
        ? collectViaSearch(session, "channel", channelId)
        : collectViaChannelHistory(session, channelId);

    launchSession(session, collect);
}

function cleanGuild(guildId: string) {
    if (!canStartNewSession(guildId)) return;

    const guild: Guild | undefined = GuildStore.getGuild(guildId);
    const currentUserId = UserStore.getCurrentUser()?.id;
    if (!guild) {
        log("Serveur introuvable", "error");
        return;
    }
    if (!currentUserId) {
        log("Impossible d'obtenir l'ID de l'utilisateur actuel", "error");
        return;
    }

    const session = createSession(
        "guild",
        guildId,
        guildId,
        currentUserId,
        `serveur ${guild.name}`
    );

    debugLog(`Nettoyage du serveur ${guildId}: fallback=${settings.store.guildFallbackScan}, délai recherche=${settings.store.searchDelay}ms`);

    launchSession(session, () => collectGuildMessages(session, guildId));
}

const GuildContextMenuPatch: NavContextMenuPatchCallback = (children, ctx: { guild?: Guild; } = {}) => {
    const { guild } = ctx;
    if (!guild) return;

    const group = findGroupChildrenByChildId("guild-header", children) ?? children;
    if (!group) return;

    const menuItems = [<Menu.MenuSeparator key="mc-separator-guild" />];
    const session = getSession(guild.id);
    const runningElsewhere = countRunningSessions(guild.id);

    if (session?.status === "running") {
        menuItems.push(
            <Menu.MenuItem
                key="mc-guild-status"
                id="vc-mc-guild-status"
                label={formatStatusLabel(session)}
                color="brand"
                disabled={true}
            />,
            <Menu.MenuItem
                key="mc-guild-stop"
                id="vc-mc-guild-stop"
                label="⏹️ Arrêter ce nettoyage"
                color="danger"
                action={() => stopSession(guild.id)}
            />
        );
    } else {
        const suffix = session?.stats.endTime
            ? ` (${session.stats.deleted} supprimé(s))`
            : "";
        menuItems.push(
            <Menu.MenuItem
                key="mc-guild-clean"
                id="vc-mc-guild-clean"
                label={`🧹 Nettoyer mes messages du serveur${suffix}`}
                color="danger"
                action={() => cleanGuild(guild.id)}
            />
        );
    }

    if (runningElsewhere > 0) {
        menuItems.push(
            <Menu.MenuItem
                key="mc-stop-all"
                id="vc-mc-stop-all"
                label={`⏹️ Arrêter les ${runningElsewhere} autre(s) nettoyage(s)`}
                color="danger"
                action={stopAllSessions}
            />
        );
    }

    group.push(...menuItems);
};

const ChannelContextMenuPatch: NavContextMenuPatchCallback = (children, ctx: { channel?: Channel; } = {}) => {
    const { channel } = ctx;
    if (!channel) return;

    const group = findGroupChildrenByChildId("mark-channel-read", children) ?? children;
    if (!group) return;

    const menuItems = [<Menu.MenuSeparator key="mc-separator-channel" />];
    const session = getSession(channel.id);
    const runningElsewhere = countRunningSessions(channel.id);

    if (session?.status === "running") {
        menuItems.push(
            <Menu.MenuItem
                key="mc-channel-status"
                id="vc-mc-channel-status"
                label={formatStatusLabel(session)}
                color="brand"
                disabled={true}
            />,
            <Menu.MenuItem
                key="mc-channel-stop"
                id="vc-mc-channel-stop"
                label="⏹️ Arrêter ce nettoyage"
                color="danger"
                action={() => stopSession(channel.id)}
            />
        );
    } else {
        const suffix = session?.stats.endTime
            ? ` (${session.stats.deleted} supprimé(s))`
            : "";
        menuItems.push(
            <Menu.MenuItem
                key="mc-channel-clean"
                id="vc-mc-channel-clean"
                label={`🧹 Nettoyer mes messages${suffix}`}
                color="danger"
                action={() => cleanChannel(channel.id)}
            />
        );
    }

    if (runningElsewhere > 0) {
        menuItems.push(
            <Menu.MenuItem
                key="mc-channel-stop-all"
                id="vc-mc-channel-stop-all"
                label={`⏹️ Arrêter les ${runningElsewhere} autre(s) nettoyage(s)`}
                color="danger"
                action={stopAllSessions}
            />
        );
    }

    group.push(...menuItems);
};

export default definePlugin({
    name: "MessageCleaner",
    description: "Nettoie vos messages par canal ou par serveur avec limiteur adaptatif anti-rate-limit, sessions indépendantes et progression en temps réel",
    authors: [{
        name: "Bash",
        id: 1327483363518582784n
    }],
    dependencies: ["ContextMenuAPI"],
    settings,

    contextMenus: {
        "channel-context": ChannelContextMenuPatch,
        "gdm-context": ChannelContextMenuPatch,
        "user-context": ChannelContextMenuPatch,
        "guild-context": GuildContextMenuPatch
    },

    start() {
        log("🚀 Plugin MessageCleaner démarré (limiteur adaptatif activé)");
    },

    stop() {
        stopAllSessions();
        log("🛑 Plugin MessageCleaner arrêté");
    }
});
