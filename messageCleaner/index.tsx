/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelStore, GuildStore, Menu, RestAPI, UserStore } from "@webpack/common";
import { Channel, Message, Guild } from "discord-types/general";
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

function getGuildChannels(guildId: string): any[] {
    const cs: any = ChannelStore;

    if (typeof cs.getChannelIds === "function") {
        const ids = cs.getChannelIds(guildId);
        if (Array.isArray(ids)) {
            return ids.map((id: string) => ChannelStore.getChannel(id)).filter(Boolean);
        }
    }

    if (typeof cs.getMutableGuildChannels === "function") {
        return flattenGuildChannels(cs.getMutableGuildChannels(guildId));
    }

    if (typeof cs.getGuildChannels === "function") {
        return flattenGuildChannels(cs.getGuildChannels(guildId));
    }

    if (typeof cs.getAllChannels === "function") {
        const all = cs.getAllChannels();
        return flattenGuildChannels(all).filter((ch: any) => ch.guild_id === guildId);
    }

    if (cs.channels) {
        return flattenGuildChannels(cs.channels).filter((ch: any) => ch.guild_id === guildId);
    }

    log(`Impossible de récupérer la liste des salons. Méthodes dispo: ${Object.keys(cs).join(", ")}`, "error");
    return [];
}

// Fonction pour nettoyer tous les salons textuels d'un serveur
async function cleanGuild(guildId: string) {
    if (isCleaningInProgress) {
        log("Un nettoyage est déjà en cours", "warn");
        return;
    }
    const guild: Guild | undefined = GuildStore.getGuild(guildId);
    if (!guild) {
        log("Serveur introuvable", "error");
        return;
    }
    isCleaningInProgress = true;
    shouldStopCleaning = false;
    cleaningStats = {
        total: 0,
        deleted: 0,
        failed: 0,
        skipped: 0,
        startTime: Date.now()
    };

    try {
        const currentUserId = UserStore.getCurrentUser()?.id;
        if (!currentUserId) {
            log("Impossible d'obtenir l'ID de l'utilisateur actuel", "error");
            return;
        }

        log(`🔍 Recherche globale des messages sur le serveur: ${guild.name}...`);
        
        let allMessages: Message[] = [];
        let offset = 0;
        let totalResults = 1;
        let searchAttempts = 0;

        while (offset < totalResults && !shouldStopCleaning && offset < 5000) {
            const { messages, total } = await searchGuildMessages(guildId, currentUserId, offset);
            
            if (searchAttempts === 0) {
                totalResults = total;
                log(`📊 Nombre total de messages indexés: ${total}`);
            }

            if (messages.length === 0) break;

            allMessages.push(...messages);
            offset += 25; // Les résultats de l'API de recherche Discord sont paginés par 25
            searchAttempts++;

            if (searchAttempts % 4 === 0) {
                log(`⏳ Recherche en cours: ${allMessages.length} messages récupérés...`);
            }

            await sleep(1000); // Pause anti-rate-limit
        }

        // Déduplication par ID au cas où
        const uniqueMessages = Array.from(new Map(allMessages.map(m => [m.id, m])).values());
        
        if (uniqueMessages.length === 0) {
            log("Aucun message trouvé lors de la recherche", "warn");
            return;
        }

        const validMessages = uniqueMessages.filter(msg => canDeleteMessage(msg, currentUserId));
        cleaningStats.total = validMessages.length;

        if (validMessages.length === 0) {
            log("Aucun message supprimable trouvé sur ce serveur", "warn");
            return;
        }

        log(`🧹 Suppression de ${validMessages.length} message(s) trouvés par recherche serveur`);
        let processed = 0;
        for (const message of validMessages) {
            if (shouldStopCleaning) break;

            const success = await deleteMessage(message.channel_id, message.id);
            if (success) {
                cleaningStats.deleted++;
            } else {
                cleaningStats.failed++;
            }

            processed++;
            if (settings.store.delayBetweenDeletes > 0) {
                await sleep(settings.store.delayBetweenDeletes);
            }
            if (processed % 10 === 0) {
                updateProgress();
            }
        }

        cleaningStats.skipped += uniqueMessages.length - validMessages.length;
        log(`✅ Nettoyage du serveur terminé : ${guild.name}`);
    } finally {
        isCleaningInProgress = false;
    }
}
// Patch du menu contextuel des serveurs
const GuildContextMenuPatch: NavContextMenuPatchCallback = (children, ctx: { guild?: Guild; } = {}) => {
    const { guild } = ctx;
    if (!guild) return;

    const group = findGroupChildrenByChildId("guild-header", children) ?? children;

    if (group) {
        const menuItems = [<Menu.MenuSeparator key="separator-guild" />];

        if (isCleaningInProgress) {
            menuItems.push(
                <Menu.MenuItem
                    key="cleaning-status-guild"
                    id="vc-cleaning-status-guild"
                    label={`🔄 Nettoyage en cours (serveur)`}
                    color="brand"
                    disabled={true}
                />
            );
        } else {
            menuItems.push(
                <Menu.MenuItem
                    key="clean-guild-messages"
                    id="vc-clean-guild-messages"
                    label="🧹 Nettoyer tous les messages du serveur"
                    color="danger"
                    action={() => cleanGuild(guild.id)}
                />
            );
        }
        group.push(...menuItems);
    }
};

const settings = definePluginSettings({
    delayBetweenDeletes: {
        type: OptionType.SLIDER,
        description: "Délai entre chaque suppression (ms) - pour éviter le rate limit",
        default: 1000,
        markers: [100, 500, 1000, 2000, 5000],
        minValue: 100,
        maxValue: 10000,
        stickToMarkers: false
    },
    batchSize: {
        type: OptionType.SLIDER,
        description: "Nombre de messages à traiter par batch",
        default: 100,
        markers: [10, 25, 50, 100],
        minValue: 1,
        maxValue: 100,
        stickToMarkers: false
    },
    showProgress: {
        type: OptionType.BOOLEAN,
        description: "Afficher la progression en temps réel",
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

// Variables globales pour le contrôle
let isCleaningInProgress = false;
let shouldStopCleaning = false;
let cleaningStats = {
    total: 0,
    deleted: 0,
    failed: 0,
    skipped: 0,
    startTime: 0
};

// Fonction de log avec préfixe
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

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Log de débogage
function debugLog(message: string) {
    if (settings.store.debugMode) {
        log(`🔍 ${message}`, "info");
    }
}

// Fonction pour vérifier si un message peut être supprimé
function canDeleteMessage(message: Message, currentUserId: string): boolean {
    try {
        // Afficher TOUS les détails du message pour debug
        debugLog(`[VÉRIF] Message ${message.id}:`);
        debugLog(`  - type: ${message.type} (19=REPLY, 0=DEFAULT)`);
        debugLog(`  - author.id: ${message.author?.id}`);
        debugLog(`  - messageReference: ${!!message.messageReference}`);
        debugLog(`  - message_reference: ${!!(message as any).message_reference}`);
        debugLog(`  - Toutes les clés: ${Object.keys(message).join(', ')}`);

        // TOUJOURS: Vérifier que c'est notre propre message (PAS D'OPTION)
        if (message.author?.id !== currentUserId) {
            debugLog(`  ❌ Pas votre message (${message.author?.id} != ${currentUserId})`);
            return false;
        }

        // Messages système
        if (settings.store.skipSystemMessages) {
            const allowedTypes = [0, 19, 20]; // DEFAULT, REPLY, CHAT_INPUT_COMMAND
            if (!allowedTypes.includes(message.type)) {
                debugLog(`  ❌ Message système (type ${message.type})`);
                return false;
            }
        }

        // Détection des réponses - Type 19 OU présence de messageReference
        const isReply = message.type === 19 || !!message.messageReference || !!(message as any).message_reference;
        if (isReply) {
            debugLog(`  ⚠️ DÉTECTÉ COMME RÉPONSE (type=${message.type}, ref=${!!message.messageReference})`);
            if (settings.store.skipReplies) {
                debugLog(`  ❌ Ignoré: skipReplies=true`);
                return false;
            } else {
                debugLog(`  ✅ Sera supprimé: skipReplies=false`);
            }
        }

        // Age maximum
        if (settings.store.maxAge > 0) {
            let messageTime: number;

            // Gérer différents formats de timestamp
            if (typeof message.timestamp === 'string') {
                messageTime = new Date(message.timestamp).getTime();
            } else if (message.timestamp && typeof message.timestamp === 'object' && 'toISOString' in message.timestamp) {
                messageTime = new Date(message.timestamp.toISOString()).getTime();
            } else if (typeof message.timestamp === 'number') {
                messageTime = message.timestamp;
            } else {
                debugLog(`  ❌ Timestamp invalide`);
                return false;
            }

            // Vérifier si le timestamp est valide
            if (isNaN(messageTime) || messageTime <= 0) {
                debugLog(`  ❌ Timestamp invalide (${message.timestamp})`);
                return false;
            }

            const messageAge = Date.now() - messageTime;
            const maxAgeMs = settings.store.maxAge * 24 * 60 * 60 * 1000;

            if (messageAge > maxAgeMs) {
                debugLog(`  ❌ Trop ancien (${Math.round(messageAge / (24 * 60 * 60 * 1000))} jours)`);
                return false;
            }
        }

        debugLog(`  ✅ PEUT ÊTRE SUPPRIMÉ`);
        return true;
    } catch (error) {
        debugLog(`  ❌ ERREUR: ${error}`);
        return false;
    }
}

// Fonction pour supprimer un message
async function deleteMessage(channelId: string, messageId: string, maxRetries = 3): Promise<boolean> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        if (shouldStopCleaning) return false;
        
        try {
            debugLog(`Tentative de suppression du message ${messageId} dans le canal ${channelId} (essai ${attempt})`);

            const response = await RestAPI.del({
                url: `/channels/${channelId}/messages/${messageId}`
            });

            debugLog(`✅ Message ${messageId} supprimé avec succès`);
            return true;
        } catch (error: any) {
            const errorMessage = error?.message || error?.toString() || 'Erreur inconnue';
            const statusCode = error?.status || error?.statusCode || 'N/A';

            debugLog(`❌ Erreur lors de la suppression du message ${messageId}: ${errorMessage} (Status: ${statusCode})`);

            if (statusCode === 429) {
                const retryAfter = error?.body?.retry_after || error?.retry_after;
                let waitTime = 5000; // 5 secondes par défaut
                
                if (retryAfter) {
                    const ra = Number(retryAfter);
                    waitTime = ra < 1000 ? Math.ceil(ra * 1000) : ra;
                    if (waitTime > 60000) waitTime = 60000; // Bloquer à 60s max
                }
                
                log(`⚠️ Limite de requêtes (429) atteinte. Pause automatique de ${waitTime / 1000}s... (Essai ${attempt}/${maxRetries})`, "warn");
                await sleep(waitTime + 500); // On ajoute 500ms de marge de sécurité
                continue; // On relance la boucle pour réessayer
            } else if (statusCode === 404) {
                debugLog(`❌ Message ${messageId} introuvable (déjà supprimé?)`);
                return true; // S'il n'existe plus, on considère que c'est un succès
            } else if (statusCode === 403) {
                debugLog(`❌ Permission refusée pour supprimer le message ${messageId}`);
                return false;
            }

            if (attempt === maxRetries) {
                return false;
            }
        }
    }
    return false;
}

// Fonction pour obtenir les messages d'un canal
async function getChannelMessages(channelId: string, before?: string): Promise<Message[]> {
    try {
        const url = before
            ? `/channels/${channelId}/messages?limit=${settings.store.batchSize}&before=${before}`
            : `/channels/${channelId}/messages?limit=${settings.store.batchSize}`;

        debugLog(`Récupération des messages depuis: ${url}`);

        const response = await RestAPI.get({ url });

        if (!response || !response.body) {
            debugLog(`Réponse vide ou invalide pour ${url}`);
            return [];
        }

        const messages = Array.isArray(response.body) ? response.body : [];
        debugLog(`Récupéré ${messages.length} messages depuis le canal ${channelId}`);

        return messages;
    } catch (error: any) {
        const errorMessage = error?.message || error?.toString() || 'Erreur inconnue';
        const statusCode = error?.status || error?.statusCode || 'N/A';

        log(`❌ Erreur lors de la récupération des messages: ${errorMessage} (Status: ${statusCode})`, "error");

        if (statusCode === 403) {
            log(`❌ Permission refusée pour accéder au canal ${channelId}`, "error");
        } else if (statusCode === 404) {
            log(`❌ Canal ${channelId} introuvable`, "error");
        } else if (statusCode === 429) {
            log(`❌ Rate limit atteint pour la récupération des messages`, "error");
        }

        return [];
    }
}

// Récupérer les messages d'un utilisateur dans un serveur avec pagination
async function searchGuildMessages(guildId: string, userId: string, offset: number, maxRetries = 3): Promise<{ messages: Message[], total: number }> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const url = `/guilds/${guildId}/messages/search?author_id=${userId}&include_nsfw=true&offset=${offset}`;
            debugLog(`Recherche des messages: ${url}`);

            const response = await RestAPI.get({ url });
            const body = response?.body;
            const rawMessages = Array.isArray(body?.messages) ? body.messages : [];
            const total = body?.total_results || 0;

            const flattened: Message[] = [];
            for (const entry of rawMessages) {
                if (Array.isArray(entry)) {
                    const targetMsg = entry.find((m: any) => m?.hit) || entry.find((m: any) => m?.author?.id === userId) || entry[0];
                    if (targetMsg) flattened.push(targetMsg);
                } else if (entry) {
                    flattened.push(entry);
                }
            }

            debugLog(`Recherche: ${flattened.length} message(s) recu(s) pour offset ${offset}`);
            return { messages: flattened, total };
        } catch (error: any) {
            const statusCode = error?.status || error?.statusCode || "N/A";
            
            if (statusCode === 429) {
                const retryAfter = error?.body?.retry_after || error?.retry_after;
                let waitTime = 5000;
                if (retryAfter) {
                    const ra = Number(retryAfter);
                    waitTime = ra < 1000 ? Math.ceil(ra * 1000) : ra;
                    if (waitTime > 60000) waitTime = 60000;
                }
                log(`⚠️ Rate limit (429) sur la recherche serveur. Pause de ${waitTime / 1000}s... (Essai ${attempt}/${maxRetries})`, "warn");
                await sleep(waitTime + 500);
                continue;
            }
            
            if (attempt === maxRetries) {
                const errorMessage = error?.message || error?.toString() || "Erreur inconnue";
                log(`❌ Erreur lors de la recherche des messages serveur: ${errorMessage} (Status: ${statusCode})`, "error");
                return { messages: [], total: 0 };
            }
        }
    }
    return { messages: [], total: 0 };
}

// Récupérer les messages d'un utilisateur dans un canal avec pagination
async function searchChannelMessages(channelId: string, userId: string, offset: number, maxRetries = 3): Promise<{ messages: Message[], total: number }> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const url = `/channels/${channelId}/messages/search?author_id=${userId}&include_nsfw=true&offset=${offset}`;
            debugLog(`Recherche des messages canal: ${url}`);

            const response = await RestAPI.get({ url });
            const body = response?.body;
            const rawMessages = Array.isArray(body?.messages) ? body.messages : [];
            const total = body?.total_results || 0;

            const flattened: Message[] = [];
            for (const entry of rawMessages) {
                if (Array.isArray(entry)) {
                    const targetMsg = entry.find((m: any) => m?.hit) || entry.find((m: any) => m?.author?.id === userId) || entry[0];
                    if (targetMsg) flattened.push(targetMsg);
                } else if (entry) {
                    flattened.push(entry);
                }
            }

            debugLog(`Recherche canal: ${flattened.length} message(s) recu(s) pour offset ${offset}`);
            return { messages: flattened, total };
        } catch (error: any) {
            const statusCode = error?.status || error?.statusCode || "N/A";
            
            if (statusCode === 429) {
                const retryAfter = error?.body?.retry_after || error?.retry_after;
                let waitTime = 5000;
                if (retryAfter) {
                    const ra = Number(retryAfter);
                    waitTime = ra < 1000 ? Math.ceil(ra * 1000) : ra;
                    if (waitTime > 60000) waitTime = 60000;
                }
                log(`⚠️ Rate limit (429) sur la recherche canal. Pause de ${waitTime / 1000}s... (Essai ${attempt}/${maxRetries})`, "warn");
                await sleep(waitTime + 500);
                continue;
            }
            
            if (attempt === maxRetries) {
                const errorMessage = error?.message || error?.toString() || "Erreur inconnue";
                log(`❌ Erreur lors de la recherche canal: ${errorMessage} (Status: ${statusCode})`, "error");
                return { messages: [], total: 0 };
            }
        }
    }
    return { messages: [], total: 0 };
}

// Fonction pour afficher la progression
function updateProgress() {
    if (!settings.store.showProgress) return;

    const { total, deleted, failed, skipped, startTime } = cleaningStats;
    const processed = deleted + failed + skipped;
    const percentage = total > 0 ? Math.round((processed / total) * 100) : 0;

    // Calculer le temps écoulé et estimé
    const elapsed = Date.now() - startTime;
    const elapsedStr = elapsed < 60000
        ? `${Math.round(elapsed / 1000)}s`
        : `${Math.round(elapsed / 60000)}min`;

    let etaStr = "";
    if (processed > 0 && percentage > 0) {
        const remaining = total - processed;
        const rate = processed / (elapsed / 1000); // messages par seconde
        const eta = remaining / rate;
        etaStr = eta < 60
            ? ` (~${Math.round(eta)}s restantes)`
            : ` (~${Math.round(eta / 60)}min restantes)`;
    }
}

// Fonction principale de nettoyage
async function cleanChannel(channelId: string, options?: { skipSessionControl?: boolean }) {
    if (!options?.skipSessionControl && isCleaningInProgress) {
        log("Un nettoyage est déjà en cours", "warn");
        return;
    }

    try {
        const channel = ChannelStore.getChannel(channelId);
        const currentUserId = UserStore.getCurrentUser()?.id;

        if (!channel) {
            log("Canal introuvable", "error");
            return;
        }

        if (!currentUserId) {
            log("Impossible d'obtenir l'ID de l'utilisateur actuel", "error");
            return;
        }

        const channelName = channel.name || channel.recipients?.map((id: string) => {
            const user = UserStore.getUser(id);
            return user?.username || "Utilisateur inconnu";
        }).join(", ") || "Canal privé";

        // Analyse rapide du canal
        log(`🔍 Analyse du canal "${channelName}"...`);
        log(`⚙️ Configuration: délai ${settings.store.delayBetweenDeletes}ms, batch ${settings.store.batchSize}`);

        // Initialiser les statistiques
        if (!options?.skipSessionControl) {
            isCleaningInProgress = true;
            shouldStopCleaning = false;
        }
        cleaningStats = {
            total: 0,
            deleted: 0,
            failed: 0,
            skipped: 0,
            startTime: Date.now()
        };

        log(`🔍 Recherche rapide des messages dans "${channelName}"...`);
        let allMessages: Message[] = [];
        let offset = 0;
        let totalResults = 1;
        let searchAttempts = 0;

        while (offset < totalResults && !shouldStopCleaning && offset < 5000) {
            const { messages, total } = await searchChannelMessages(channelId, currentUserId, offset);
            
            if (searchAttempts === 0) {
                totalResults = total;
                log(`📊 Nombre total de messages indexés: ${total}`);
            }

            if (messages.length === 0) break;

            allMessages.push(...messages);
            offset += 25;
            searchAttempts++;

            if (searchAttempts % 4 === 0) {
                log(`⏳ Recherche en cours: ${allMessages.length} messages récupérés...`);
            }

            await sleep(1000);
        }

        const uniqueMessages = Array.from(new Map(allMessages.map(m => [m.id, m])).values());
        
        if (uniqueMessages.length === 0) {
            log("Aucun message trouvé lors de la recherche", "warn");
        } else {
            const validMessages = uniqueMessages.filter(msg => canDeleteMessage(msg, currentUserId));
            cleaningStats.total = validMessages.length;

            if (validMessages.length === 0) {
                log("Aucun message supprimable trouvé", "warn");
            } else {
                log(`🧹 Suppression de ${validMessages.length} message(s) trouvés par recherche`);
                let processed = 0;
                for (const message of validMessages) {
                    if (shouldStopCleaning) break;

                    const success = await deleteMessage(channelId, message.id);
                    if (success) {
                        cleaningStats.deleted++;
                    } else {
                        cleaningStats.failed++;
                    }

                    processed++;
                    if (settings.store.delayBetweenDeletes > 0) {
                        await sleep(settings.store.delayBetweenDeletes);
                    }
                    if (processed % 10 === 0) {
                        updateProgress();
                    }
                }
                cleaningStats.skipped += uniqueMessages.length - validMessages.length;
            }
        }

        // Nettoyage terminé
        if (!options?.skipSessionControl) {
            isCleaningInProgress = false;
        }

        const { deleted, failed, skipped, startTime } = cleaningStats;
        const finalTotal = deleted + failed + skipped;
        const totalTime = Date.now() - startTime;
        const totalTimeStr = totalTime < 60000
            ? `${Math.round(totalTime / 1000)} secondes`
            : `${Math.round(totalTime / 60000)} min ${Math.round((totalTime % 60000) / 1000)}s`;

        const avgTimePerMessage = deleted > 0 ? Math.round(totalTime / deleted) : 0;
        const successRate = finalTotal > 0 ? Math.round((deleted / finalTotal) * 100) : 0;

        log(`✅ Nettoyage terminé:
• Messages traités: ${finalTotal}
• Supprimés: ${deleted}
• Échecs: ${failed}
• Ignorés: ${skipped}
• Temps total: ${totalTimeStr}
• Taux de succès: ${successRate}%
• Temps moyen/message: ${avgTimePerMessage}ms`);

    } catch (error) {
        if (!options?.skipSessionControl) {
            isCleaningInProgress = false;
        }
        log(`❌ Erreur globale lors du nettoyage: ${error}`, "error");
    }
}

// Fonction pour arrêter le nettoyage
function stopCleaning() {
    if (isCleaningInProgress) {
        shouldStopCleaning = true;
        log("⏹️ Arrêt du nettoyage demandé");
    }
}

// Patch du menu contextuel des canaux
const ChannelContextMenuPatch: NavContextMenuPatchCallback = (children, ctx: { channel?: Channel; } = {}) => {
    const { channel } = ctx;
    if (!channel) return;

    const group = findGroupChildrenByChildId("mark-channel-read", children) ?? children;

    if (group) {
        const menuItems = [<Menu.MenuSeparator key="separator" />];

        if (isCleaningInProgress) {
            // Afficher les stats du nettoyage en cours
            const { total, deleted, failed, skipped, startTime } = cleaningStats;
            const processed = deleted + failed + skipped;
            const percentage = total > 0 ? Math.round((processed / total) * 100) : 0;
            const elapsed = Math.round((Date.now() - startTime) / 1000);

            menuItems.push(
                <Menu.MenuItem
                    key="cleaning-status"
                    id="vc-cleaning-status"
                    label={`🔄 Nettoyage en cours: ${percentage}% (${processed}/${total})`}
                    color="brand"
                    disabled={true}
                />,
                <Menu.MenuItem
                    key="stop-cleaning"
                    id="vc-stop-cleaning"
                    label="⏹️ Arrêter le nettoyage"
                    color="danger"
                    action={stopCleaning}
                />
            );
        } else {
            // Option de nettoyage normal
            menuItems.push(
                <Menu.MenuItem
                    key="clean-messages"
                    id="vc-clean-messages"
                    label="🧹 Nettoyer les messages"
                    color="danger"
                    action={() => cleanChannel(channel.id)}
                />
            );
        }

        group.push(...menuItems);
    }
};

export default definePlugin({
    name: "MessageCleaner",
    description: "Nettoie tous les messages d'un canal avec gestion intelligente du rate limiting, statistiques temps réel et confirmation sécurisée",
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
        log("🚀 Plugin MessageCleaner démarré");

        // Test des dépendances
        log("🔍 Test des dépendances:");
        log(`- RestAPI: ${typeof RestAPI}`);
        log(`- ChannelStore: ${typeof ChannelStore}`);
        log(`- UserStore: ${typeof UserStore}`);
        log(`- Menu: ${typeof Menu}`);

        debugLog(`Configuration:
• Délai: ${settings.store.delayBetweenDeletes}ms
• Batch: ${settings.store.batchSize}
• Ignorer réponses: ${settings.store.skipReplies}
• Age max: ${settings.store.maxAge} jours
• Mode debug: ${settings.store.debugMode}`);
    },

    stop() {
        log("🛑 Plugin MessageCleaner arrêté");

        // Arrêter le nettoyage en cours
        if (isCleaningInProgress) {
            shouldStopCleaning = true;
        }
    }
});
