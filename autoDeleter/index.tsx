/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { Constants, FluxDispatcher, MessageStore, RestAPI, UserStore } from "@webpack/common";

interface TrackedMessage {
    id: string;
    channelId: string;
    guildId?: string;
    timestamp: number;
    scheduledTime: number; // Timestamp absolu de suppression programmée
    timeoutId?: NodeJS.Timeout; // Optionnel car pas sauvegardé
    content?: string; // Contenu original pour debug
    length?: number; // Longueur du message
    priority?: number; // Priorité de suppression (1-10)
}

interface DeletionStats {
    messagesDeleted: number;
    messagesSaved: number;
    errors: number;
    restoredFromStorage: number;
    hourlyDeletions: number;
    lastHourReset: number;
    totalBytesSaved: number;
    averageMessageLength: number;
    channelStats: Record<string, number>;
}

const settings = definePluginSettings({
    defaultDelay: {
        type: OptionType.NUMBER,
        description: "Délai avant suppression (en unité rentrée en bas)",
        default: 300, // 5 minutes
        min: 5,
        max: 86400 // 24 heures
    },
    delayUnit: {
        type: OptionType.SELECT,
        description: "Unité de temps",
        options: [
            { label: "Secondes", value: "seconds", default: true },
            { label: "Minutes", value: "minutes" },
            { label: "Heures", value: "hours" }
        ]
    },
    excludedChannels: {
        type: OptionType.STRING,
        description: "IDs des salons exclus (géré par les commandes /autodeleter)",
        default: ""
    }
});

const STORAGE_KEY = "AutoDeleter_TrackedMessages";

// Fonctions utilitaires pour la suppression AntiLog
async function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function parseCsvList(raw: string): string[] {
    return raw
        .split(",")
        .map(item => item.trim())
        .filter(Boolean);
}

export default definePlugin({
    name: "AutoDeleter",
    description: "Supprime automatiquement vos messages après un délai configurable (persistant après redémarrage)",
    authors: [{
        name: "Bash",
        id: 1327483363518582784n
    }],
    settings,

    commands: [{
        name: "autodeleter",
        description: "Gérer l'AutoDeleter pour ce salon",
        options: [
            {
                name: "action",
                description: "Exclure (exclude) ou Inclure (include) ce salon",
                type: 3,
                required: true,
                choices: [
                    { name: "exclude", displayName: "Exclure ce salon", label: "Exclure ce salon", value: "exclude" },
                    { name: "include", displayName: "Inclure ce salon", label: "Inclure ce salon", value: "include" }
                ]
            }
        ],
        execute(args: any, ctx: any) {
            const action = args.find((a: any) => a.name === "action")?.value;
            const channelId = ctx.channel.id;
            
            const excludedStr = settings.store.excludedChannels || "";
            let excludedList = excludedStr.split(",").map((i: string) => i.trim()).filter(Boolean);
            
            if (action === "exclude") {
                if (!excludedList.includes(channelId)) {
                    excludedList.push(channelId);
                    settings.store.excludedChannels = excludedList.join(",");
                    return { content: "✅ Ce salon a été ajouté à la liste d'exclusion. L'AutoDeleter n'agira plus ici." };
                } else {
                    return { content: "ℹ️ Ce salon est déjà dans la liste d'exclusion." };
                }
            } else if (action === "include") {
                if (excludedList.includes(channelId)) {
                    excludedList = excludedList.filter((id: string) => id !== channelId);
                    settings.store.excludedChannels = excludedList.join(",");
                    return { content: "✅ Ce salon a été retiré de la liste d'exclusion. L'AutoDeleter fonctionnera de nouveau ici." };
                } else {
                    return { content: "ℹ️ Ce salon n'était pas dans la liste d'exclusion." };
                }
            }
            return { content: "Action invalide." };
        }
    }],

    // Map pour suivre les messages en attente de suppression
    trackedMessages: new Map<string, TrackedMessage>(),

    // Fonction liée pour l'événement MESSAGE_CREATE
    boundOnMessageCreate: null as any,

    // Statistiques avancées
    stats: {
        messagesDeleted: 0,
        messagesSaved: 0,
        errors: 0,
        restoredFromStorage: 0,
        hourlyDeletions: 0,
        lastHourReset: Date.now(),
        totalBytesSaved: 0,
        averageMessageLength: 0,
        channelStats: {} as Record<string, number>
    } as DeletionStats,

    // Cache pour optimiser les performances
    messageCache: new Map<string, any>(),
    channelCache: new Map<string, any>(),

    // Queue de suppression par lots
    deletionQueue: [] as Array<{ messageId: string; channelId: string; }>,
    batchProcessor: null as NodeJS.Timeout | null,

    // Gestion des rate limits avancée
    rateLimitInfo: {
        isRateLimited: false,
        retryAfter: 0,
        lastRateLimit: 0,
        consecutiveRateLimits: 0,
        backoffMultiplier: 1,
        globalCooldown: false,
        globalCooldownUntil: 0,
        circuitBreakerOpen: false,
        circuitBreakerUntil: 0,
        totalRateLimits: 0,
        lastSuccessfulDeletion: 0
    },

    // Cache des tentatives de suppression
    retryQueue: [] as Array<{ messageId: string; channelId: string; attempts: number; nextRetry: number; }>,
    retryProcessor: null as NodeJS.Timeout | null,

    // Horodatage de démarrage pour les stats d'uptime
    startTime: 0,

    // Throttling intelligent
    throttlingInfo: {
        lastDeletionTime: 0,
        deletionCount: 0,
        windowStart: 0,
        maxDeletionsPerMinute: 10,
        minDelayBetweenDeletions: 2000 // 2 secondes minimum
    },

    async start() {
        this.log("Plugin AutoDeleter démarré");
        this.startTime = Date.now();

        // Lier le contexte pour onMessageCreate
        this.boundOnMessageCreate = this.onMessageCreate.bind(this);

        // Écouter les nouveaux messages
        FluxDispatcher.subscribe("MESSAGE_CREATE", this.boundOnMessageCreate);

        // Restaurer les messages depuis le stockage
        await this.restoreTrackedMessages();

        this.log(`Restauration terminée: ${this.stats.restoredFromStorage} messages restaurés`);
    },

    stop() {
        this.log("Plugin AutoDeleter arrêté");

        // Arrêter d'écouter les messages
        if (this.boundOnMessageCreate) {
            FluxDispatcher.unsubscribe("MESSAGE_CREATE", this.boundOnMessageCreate);
        }

        // Annuler tous les timeouts en cours
        this.trackedMessages.forEach(message => {
            if (message.timeoutId) {
                clearTimeout(message.timeoutId);
            }
        });

        // Arrêter les processeurs pour éviter les boucles résiduelles
        if (this.batchProcessor) {
            clearInterval(this.batchProcessor);
            this.batchProcessor = null;
        }

        if (this.retryProcessor) {
            clearInterval(this.retryProcessor);
            this.retryProcessor = null;
        }

        // Sauvegarder les messages restants
        this.saveTrackedMessages();
    },

    // Sauvegarder les messages programmés
    async saveTrackedMessages() {
        try {
            const messagesToSave = Array.from(this.trackedMessages.values() as any).map((msg: any) => ({
                id: msg.id,
                channelId: msg.channelId,
                timestamp: msg.timestamp,
                scheduledTime: msg.scheduledTime
            }));

            await DataStore.set(STORAGE_KEY, messagesToSave);
            this.debug(`Sauvegarde: ${messagesToSave.length} messages sauvegardés`);
        } catch (error) {
            this.error("Erreur lors de la sauvegarde des messages:", error);
        }
    },

    // Restaurer les messages depuis le stockage
    async restoreTrackedMessages() {
        try {
            const savedMessages = await DataStore.get<TrackedMessage[]>(STORAGE_KEY);

            if (!savedMessages || savedMessages.length === 0) {
                this.debug("Aucun message à restaurer");
                return;
            }

            const now = Date.now();
            let restoredCount = 0;

            for (const savedMsg of savedMessages) {
                const timeUntilDeletion = savedMsg.scheduledTime - now;

                // Si le message aurait dû être supprimé, le supprimer maintenant
                if (timeUntilDeletion <= 0) {
                    this.debug(`Message ${savedMsg.id} aurait dû être supprimé, suppression immédiate`);
                    await this.deleteMessage(savedMsg.id, savedMsg.channelId);
                    continue;
                }

                // Reprogrammer la suppression
                // (On ne vérifie pas MessageStore car le cache local est vidé au redémarrage de Discord)
                this.scheduleMessageDeletionFromRestore(savedMsg, timeUntilDeletion);
                restoredCount++;
            }

            this.stats.restoredFromStorage = restoredCount;
            this.debug(`Restauration: ${restoredCount} messages reprogrammés`);

        } catch (error) {
            this.error("Erreur lors de la restauration des messages:", error);
        }
    },

    onMessageCreate(event: any) {
        try {


            const message = event?.message;
            if (!message) return;

            // Vérifier si c'est notre message
            const currentUser = UserStore.getCurrentUser();
            if (!message.author || !currentUser || message.author.id !== currentUser.id) {
                return;
            }

            // Vérifier le circuit breaker
            if (this.rateLimitInfo.circuitBreakerOpen) {
                const now = Date.now();
                if (now < this.rateLimitInfo.circuitBreakerUntil) {
                    this.debug("Circuit breaker ouvert - suppression ignorée");
                    return;
                } else {
                    // Reset du circuit breaker
                    this.rateLimitInfo.circuitBreakerOpen = false;
                    this.rateLimitInfo.circuitBreakerUntil = 0;
                    this.log("Circuit breaker fermé - reprise des suppressions");
                }
            }

            // Vérifier le cooldown global
            if (this.rateLimitInfo.globalCooldown) {
                const now = Date.now();
                if (now < this.rateLimitInfo.globalCooldownUntil) {
                    this.debug("Cooldown global actif - suppression ignorée");
                    return;
                } else {
                    this.rateLimitInfo.globalCooldown = false;
                    this.rateLimitInfo.globalCooldownUntil = 0;
                }
            }

            // Vérifier le throttling intelligent
            if (!this.checkThrottlingLimits()) {
                this.debug("Limites de throttling atteintes");
                return;
            }

            // Vérifier les filtres de canal
            if (!this.shouldProcessChannel(message.channel_id)) {
                this.debug(`Canal ${message.channel_id} ignoré par les filtres`);
                return;
            }

            // Programmer la suppression avec délai intelligent
            const delay = this.getDelayInMs();
            this.scheduleMessageDeletion(message, delay);
        } catch (error) {
            this.error("Erreur dans onMessageCreate:", error);
        }
    },

    shouldProcessChannel(channelId: string): boolean {
        const excludedStr = settings.store.excludedChannels || "";
        const excludedList = parseCsvList(excludedStr);
        return !excludedList.includes(channelId);
    },





    checkThrottlingLimits(): boolean {
        if (!true) return true;

        const now = Date.now();
        const minuteInMs = 60 * 1000;

        // Reset de la fenêtre de temps si nécessaire
        if (now - this.throttlingInfo.windowStart > minuteInMs) {
            this.throttlingInfo.deletionCount = 0;
            this.throttlingInfo.windowStart = now;
        }

        // Vérifier le nombre de suppressions par minute
        const maxPerMinute = 8;
        if (this.throttlingInfo.deletionCount >= maxPerMinute) {
            this.debug(`Limite de ${maxPerMinute} suppressions par minute atteinte`);
            return false;
        }

        // Vérifier le délai minimum entre les suppressions
        const minDelay = 2000;
        const timeSinceLastDeletion = now - this.throttlingInfo.lastDeletionTime;
        if (timeSinceLastDeletion < minDelay) {
            this.debug(`Délai minimum de ${minDelay}ms non respecté`);
            return false;
        }

        return true;
    },

    updateThrottlingInfo() {
        const now = Date.now();
        this.throttlingInfo.lastDeletionTime = now;
        this.throttlingInfo.deletionCount++;
        this.rateLimitInfo.lastSuccessfulDeletion = now;
    },

    scheduleMessageDeletion(message: any, customDelay?: number) {
        const delay = customDelay || this.getDelayInMs();
        const scheduledTime = Date.now() + delay;
                const existing = this.trackedMessages.get(message.id);
        if (existing?.timeoutId) {
            clearTimeout(existing.timeoutId);
        }

        this.debug(`Programmation suppression message ${message.id} dans ${delay}ms (${new Date(scheduledTime).toLocaleString()})`);

        const timeoutId = setTimeout(() => {
            if (false) { // debug disabled
                this.addToDeletionQueue(message.id, message.channel_id);
            } else {
                this.deleteMessage(message.id, message.channel_id);
            }
        }, delay);

        // Suivre le message avec plus d'informations
        const trackedMessage: TrackedMessage = {
            id: message.id,
            channelId: message.channel_id,
            guildId: message.guild_id,
            timestamp: Date.now(),
            scheduledTime: scheduledTime,
            timeoutId: timeoutId,
            content: message.content,
            length: (message.content || "").length,
            priority: this.calculatePriority(message)
        };

        this.trackedMessages.set(message.id, trackedMessage);
        this.messageCache.set(message.id, message);

        // Sauvegarder immédiatement
        this.saveTrackedMessages();
    },

    calculatePriority(message: any): number {
        let priority = 5; // Priorité par défaut

        // Messages plus longs = priorité plus élevée
        const contentLength = (message.content || "").length;
        if (contentLength > 500) priority += 2;
        if (contentLength > 1000) priority += 1;

        // Messages avec médias = priorité plus élevée
        if (message.embeds?.length > 0 || message.attachments?.length > 0) {
            priority += 1;
        }

        return Math.min(priority, 10);
    },

    addToDeletionQueue(messageId: string, channelId: string) {
        this.deletionQueue.push({ messageId, channelId });

        if (!this.batchProcessor) {
            this.startBatchProcessor();
        }
    },

    startBatchProcessor() {
        this.batchProcessor = setInterval(() => {
            this.processBatchDeletion();
        }, 200);
    },

    async processBatchDeletion() {
        if (this.deletionQueue.length === 0) {
            if (this.batchProcessor) {
                clearInterval(this.batchProcessor);
                this.batchProcessor = null;
            }
            return;
        }

        const batch = this.deletionQueue.splice(0, 5);

        for (const item of batch) {
            try {
                await this.deleteMessage(item.messageId, item.channelId);
            } catch (error) {
                this.error("Erreur dans le batch de suppression:", error);
            }
        }
    },

    scheduleMessageDeletionFromRestore(savedMsg: TrackedMessage, delay: number) {
        this.debug(`Reprogrammation suppression message ${savedMsg.id} dans ${delay}ms`);

        const timeoutId = setTimeout(() => {
            this.deleteMessage(savedMsg.id, savedMsg.channelId);
        }, delay);

        // Mettre à jour le message avec le nouveau timeout
        const trackedMessage: TrackedMessage = {
            ...savedMsg,
            timeoutId: timeoutId
        };

        this.trackedMessages.set(savedMsg.id, trackedMessage);
    },

    async deleteMessage(messageId: string, channelId: string, attempt: number = 1) {
        try {
            this.debug(`Tentative de suppression du message ${messageId} (tentative ${attempt})`);

            // Vérifier si on est en rate limit
            if (this.rateLimitInfo.isRateLimited && true) {
                const timeSinceLastRateLimit = Date.now() - this.rateLimitInfo.lastRateLimit;
                if (timeSinceLastRateLimit < this.rateLimitInfo.retryAfter * 1000) {
                    this.debug(`Rate limit actif, ajout à la queue de retry: ${messageId}`);
                    this.addToRetryQueue(messageId, channelId, attempt);
                    return;
                } else {
                    // Reset du rate limit
                    this.rateLimitInfo.isRateLimited = false;
                    this.rateLimitInfo.consecutiveRateLimits = 0;
                    this.rateLimitInfo.backoffMultiplier = 1;
                }
            }

            // Vérifier le throttling avant la suppression
            if (!this.checkThrottlingLimits()) {
                this.debug(`Throttling actif, ajout à la queue de retry: ${messageId}`);
                this.addToRetryQueue(messageId, channelId, attempt, 5000);
                return;
            }

            await this.performNormalDeletion(messageId, channelId);

            // Mettre à jour les statistiques seulement après succès réel
            this.stats.hourlyDeletions++;
                        this.stats.channelStats[channelId] = (this.stats.channelStats[channelId] || 0) + 1;

            const trackedMessage = this.trackedMessages.get(messageId);
            if (trackedMessage) {
                this.stats.totalBytesSaved += trackedMessage.length || 0;
                this.updateAverageMessageLength(trackedMessage.length || 0);
            }

            this.log(`Message ${messageId} supprimé avec succès`);
            this.stats.messagesDeleted++;

            // Mettre à jour les informations de throttling
            this.updateThrottlingInfo();

            // Reset du compteur de rate limits en cas de succès
            if (this.rateLimitInfo.consecutiveRateLimits > 0) {
                this.rateLimitInfo.consecutiveRateLimits = Math.max(0, this.rateLimitInfo.consecutiveRateLimits - 1);
            }

            if (false) { // debug disabled
                this.showNotification(`Message supprimé`, "success");
            }

        } catch (error: any) {
            this.handleDeletionError(error, messageId, channelId, attempt);
        } finally {
            // Retirer le message du suivi et du cache seulement si pas en retry
            if (!this.retryQueue.some(item => item.messageId === messageId)) {
                this.trackedMessages.delete(messageId);
                this.messageCache.delete(messageId);
                // Sauvegarder après suppression
                this.saveTrackedMessages();
            }
        }
    },

    handleDeletionError(error: any, messageId: string, channelId: string, attempt: number) {
        this.error(`Erreur lors de la suppression du message ${messageId}:`, error);
        this.stats.errors++;

        // Gestion spécifique des rate limits
        if (error.status === 429 && true) {
            this.handleRateLimit(error, messageId, channelId, attempt);
        } else if (error.status === 404) {
            // Message déjà supprimé ou introuvable
            this.debug(`Message ${messageId} déjà supprimé ou introuvable`);
            this.trackedMessages.delete(messageId);
            this.messageCache.delete(messageId);
        } else if (attempt < 3) {
            // Autres erreurs - retry
            this.debug(`Tentative ${attempt + 1} pour le message ${messageId}`);
            this.addToRetryQueue(messageId, channelId, attempt + 1);
        } else {
            // Trop de tentatives
            this.error(`Abandon de la suppression du message ${messageId} après ${attempt} tentatives`);
            this.trackedMessages.delete(messageId);
            this.messageCache.delete(messageId);
        }

        if (false) { // debug disabled
            this.showNotification("Erreur lors de la suppression", "error");
        }
    },

    handleRateLimit(error: any, messageId: string, channelId: string, attempt: number) {
        const retryAfter = error.body?.retry_after || 1;

        this.rateLimitInfo.isRateLimited = true;
        this.rateLimitInfo.retryAfter = retryAfter;
        this.rateLimitInfo.lastRateLimit = Date.now();
        this.rateLimitInfo.consecutiveRateLimits++;
        this.rateLimitInfo.totalRateLimits++;

        // Augmenter le multiplicateur de backoff
        if (true) {
            this.rateLimitInfo.backoffMultiplier = Math.min(10, 1 + (this.rateLimitInfo.consecutiveRateLimits * 0.5));
        }

        // Activer le cooldown global si trop de rate limits
        if (this.rateLimitInfo.consecutiveRateLimits >= 3) {
            const cooldownDuration = Math.min(30000, retryAfter * 1000 * 2); // Max 30 secondes
            this.rateLimitInfo.globalCooldown = true;
            this.rateLimitInfo.globalCooldownUntil = Date.now() + cooldownDuration;
            this.log(`Cooldown global activé pour ${cooldownDuration}ms`);
        }

        // Ouvrir le circuit breaker si trop de rate limits consécutifs
        const threshold = 5;
        if (this.rateLimitInfo.consecutiveRateLimits >= threshold) {
            const duration = 5 * 60 * 1000; // Convertir en ms
            this.rateLimitInfo.circuitBreakerOpen = true;
            this.rateLimitInfo.circuitBreakerUntil = Date.now() + duration;
            this.log(`Circuit breaker ouvert pour ${5} minutes`);
        }

        this.log(`Rate limit détecté - Retry après ${retryAfter}s (tentative ${attempt}) - Total: ${this.rateLimitInfo.totalRateLimits}`);

        if (attempt < 3) {
            // Délai plus long pour les retries
            const retryDelay = Math.max(retryAfter * 1000, 5000); // Minimum 5 secondes
            this.addToRetryQueue(messageId, channelId, attempt, retryDelay);
        } else {
            this.error(`Abandon après rate limit - Message ${messageId}`);
            this.trackedMessages.delete(messageId);
            this.messageCache.delete(messageId);
        }
    },

    addToRetryQueue(messageId: string, channelId: string, attempts: number, delay: number = 0) {
        const baseDelay = delay || (1000 * this.rateLimitInfo.backoffMultiplier);
        const nextRetry = Date.now() + baseDelay;

        const existing = this.retryQueue.find(item => item.messageId === messageId);
        if (existing) {
            existing.channelId = channelId;
            existing.attempts = Math.max(existing.attempts, attempts);
            existing.nextRetry = Math.min(existing.nextRetry, nextRetry);
            this.debug(`Retry déjà en queue: ${messageId} (mise à jour)`);
            return;
        }

        this.retryQueue.push({
            messageId,
            channelId,
            attempts,
            nextRetry
        });

        this.debug(`Ajouté à la queue de retry: ${messageId} (retry dans ${baseDelay}ms)`);

        if (!this.retryProcessor) {
            this.startRetryProcessor();
        }
    },

    startRetryProcessor() {
        this.retryProcessor = setInterval(() => {
            this.processRetryQueue();
        }, 1000); // Vérifier chaque seconde
    },

    processRetryQueue() {
        const now = Date.now();
        const readyToRetry = this.retryQueue.filter(item => item.nextRetry <= now);

        if (readyToRetry.length === 0) {
            if (this.retryQueue.length === 0 && this.retryProcessor) {
                clearInterval(this.retryProcessor);
                this.retryProcessor = null;
            }
            return;
        }

        // Traiter les retries prêts
        for (const item of readyToRetry) {
            const index = this.retryQueue.indexOf(item);
            if (index > -1) {
                this.retryQueue.splice(index, 1);
            }

            this.debug(`Retry du message ${item.messageId} (tentative ${item.attempts})`);
            this.deleteMessage(item.messageId, item.channelId, item.attempts);
        }
    },

    async performNormalDeletion(messageId: string, channelId: string) {
        await RestAPI.del({
            url: `/channels/${channelId}/messages/${messageId}`
        });
    },

    getDelayInMs(): number {
        const delay = settings.store.defaultDelay;
        const unit = settings.store.delayUnit;

        switch (unit) {
            case "seconds":
                return delay * 1000;
            case "minutes":
                return delay * 60 * 1000;
            case "hours":
                return delay * 60 * 60 * 1000;
            default:
                return delay * 1000;
        }
    },

    updateAverageMessageLength(newLength: number) {
        const totalMessages = this.stats.messagesDeleted;
        if (totalMessages === 1) {
            this.stats.averageMessageLength = newLength;
        } else {
            this.stats.averageMessageLength =
                (this.stats.averageMessageLength * (totalMessages - 1) + newLength) / totalMessages;
        }
    },

    // Méthodes de logging
    log(message: string, ...args: any[]) {
        console.log(`[AutoDeleter] ${message}`, ...args);
    },

    debug(message: string, ...args: any[]) {
        if (false) { // debug disabled
            console.debug(`[AutoDeleter DEBUG] ${message}`, ...args);
        }
    },

    error(message: string, ...args: any[]) {
        console.error(`[AutoDeleter ERROR] ${message}`, ...args);
    },

    // Méthodes utilitaires pour les statistiques
    getStats() {
        return {
            ...this.stats,
            trackedMessages: this.trackedMessages.size,
            queueSize: this.deletionQueue.length,
            retryQueueSize: this.retryQueue.length,
            cacheSize: this.messageCache.size,
            uptime: Date.now() - (this.startTime || Date.now()),
            efficiency: this.calculateEfficiency(),
            rateLimitInfo: this.getRateLimitInfo()
        };
    },

    calculateEfficiency(): number {
        const total = this.stats.messagesDeleted + this.stats.messagesSaved;
        if (total === 0) return 0;
        return Math.round((this.stats.messagesDeleted / total) * 100);
    },

    resetStats() {
        this.stats = {
            messagesDeleted: 0,
            messagesSaved: 0,
            errors: 0,
            restoredFromStorage: 0,
            hourlyDeletions: 0,
            lastHourReset: Date.now(),
            totalBytesSaved: 0,
            averageMessageLength: 0,
            channelStats: {}
        };
        this.log("Statistiques réinitialisées");
    },

    // Méthodes de gestion d'urgence
    emergencyStopAll() {
        this.log("ARRÊT D'URGENCE ACTIVÉ - Annulation de toutes les suppressions");

        // Annuler tous les timeouts
        this.trackedMessages.forEach(message => {
            if (message.timeoutId) {
                clearTimeout(message.timeoutId);
            }
        });

        // Vider les queues
        this.deletionQueue = [];
        this.retryQueue = [];

        // Arrêter les processeurs
        if (this.batchProcessor) {
            clearInterval(this.batchProcessor);
            this.batchProcessor = null;
        }

        if (this.retryProcessor) {
            clearInterval(this.retryProcessor);
            this.retryProcessor = null;
        }

        // Reset des rate limits
        this.rateLimitInfo = {
            isRateLimited: false,
            retryAfter: 0,
            lastRateLimit: 0,
            consecutiveRateLimits: 0,
            backoffMultiplier: 1,
            globalCooldown: false,
            globalCooldownUntil: 0,
            circuitBreakerOpen: false,
            circuitBreakerUntil: 0,
            totalRateLimits: 0,
            lastSuccessfulDeletion: 0
        };

        // Reset du throttling
        this.throttlingInfo = {
            lastDeletionTime: 0,
            deletionCount: 0,
            windowStart: 0,
            maxDeletionsPerMinute: 8,
            minDelayBetweenDeletions: 2000
        };

        // Vider les caches
        this.messageCache.clear();
        this.channelCache.clear();

        this.log("Arrêt d'urgence terminé");
    },

    // Méthode pour obtenir les informations de rate limit
    getRateLimitInfo() {
        return {
            ...this.rateLimitInfo,
            retryQueueSize: this.retryQueue.length,
            isProcessing: !!this.retryProcessor,
            throttlingInfo: this.throttlingInfo
        };
    },

    // Méthode pour forcer le reset des rate limits
    resetRateLimits() {
        this.rateLimitInfo = {
            isRateLimited: false,
            retryAfter: 0,
            lastRateLimit: 0,
            consecutiveRateLimits: 0,
            backoffMultiplier: 1,
            globalCooldown: false,
            globalCooldownUntil: 0,
            circuitBreakerOpen: false,
            circuitBreakerUntil: 0,
            totalRateLimits: 0,
            lastSuccessfulDeletion: 0
        };

        this.throttlingInfo = {
            lastDeletionTime: 0,
            deletionCount: 0,
            windowStart: 0,
            maxDeletionsPerMinute: 8,
            minDelayBetweenDeletions: 2000
        };

        this.log("Rate limits et throttling réinitialisés");
    },

    // Méthode pour forcer la fermeture du circuit breaker
    closeCircuitBreaker() {
        this.rateLimitInfo.circuitBreakerOpen = false;
        this.rateLimitInfo.circuitBreakerUntil = 0;
        this.log("Circuit breaker fermé manuellement");
    },

    // Méthode pour forcer l'arrêt du cooldown global
    stopGlobalCooldown() {
        this.rateLimitInfo.globalCooldown = false;
        this.rateLimitInfo.globalCooldownUntil = 0;
        this.log("Cooldown global arrêté manuellement");
    },

    // Méthode pour récupérer les messages en attente
    getPendingMessages() {
        return Array.from(this.trackedMessages.values() as any).map((msg: any) => ({
            id: msg.id,
            channelId: msg.channelId,
            scheduledTime: new Date(msg.scheduledTime).toLocaleString(),
            timeRemaining: Math.max(0, msg.scheduledTime - Date.now()),
            content: (msg.content || "").substring(0, 50) + ((msg.content?.length || 0) > 50 ? "..." : ""),
            priority: msg.priority || 5
        }));
    },

    // Méthode pour annuler la suppression d'un message spécifique
    cancelMessageDeletion(messageId: string) {
        const trackedMessage = this.trackedMessages.get(messageId);
        if (trackedMessage && trackedMessage.timeoutId) {
            clearTimeout(trackedMessage.timeoutId);
            this.trackedMessages.delete(messageId);
            this.messageCache.delete(messageId);
            this.saveTrackedMessages();
            this.log(`Suppression annulée pour le message ${messageId}`);
            return true;
        }
        return false;
    },

    // Méthode pour nettoyer le stockage (utile pour le debug)
    async clearStorage() {
        try {
            await DataStore.del(STORAGE_KEY);
            this.log("Stockage nettoyé");
        } catch (error) {
            this.error("Erreur lors du nettoyage du stockage:", error);
        }
    },

    // Méthode pour exporter les statistiques
    exportStats() {
        const stats = this.getStats();
        const dataStr = JSON.stringify(stats, null, 2);
        const dataBlob = new Blob([dataStr], { type: "application/json" });
        const url = URL.createObjectURL(dataBlob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `autodeleter-stats-${new Date().toISOString().split("T")[0]}.json`;
        link.click();
        URL.revokeObjectURL(url);
        this.log("Statistiques exportées");
    },

    // Méthode pour importer des paramètres
    async importSettings(settingsData: string) {
        try {
            const importedSettings = JSON.parse(settingsData);
            // Valider et appliquer les paramètres importés
            Object.keys(importedSettings).forEach(key => {
                if (Object.prototype.hasOwnProperty.call(settings.store, key)) {
                    settings.store[key] = importedSettings[key];
                }
            });
            this.log("Paramètres importés avec succès");
        } catch (error) {
            this.error("Erreur lors de l'importation des paramètres:", error);
        }
    },

    // Méthode pour optimiser les performances
    optimizePerformance() {
        // Nettoyer les caches anciens
        const now = Date.now();
        const maxCacheAge = 30 * 60 * 1000; // 30 minutes

        this.messageCache.forEach((message, id) => {
            if (now - message.timestamp > maxCacheAge) {
                this.messageCache.delete(id);
            }
        });

        this.channelCache.forEach((channel, id) => {
            if (now - channel.timestamp > maxCacheAge) {
                this.channelCache.delete(id);
            }
        });

        this.debug(`Optimisation terminée - Cache: ${this.messageCache.size} messages, ${this.channelCache.size} canaux`);
    }
});
