/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import definePlugin from "@utils/types";
import { findByPropsLazy, findStoreLazy } from "@webpack";
import { UserStore } from "@webpack/common";

// Récupération des stores et actions nécessaires
const VoiceStateStore = findStoreLazy("VoiceStateStore");
const ChannelActions = findByPropsLazy("selectVoiceChannel");

interface VoiceState {
    userId: string;
    channelId?: string;
    oldChannelId?: string;
    guildId?: string;
    deaf: boolean;
    mute: boolean;
    selfDeaf: boolean;
    selfMute: boolean;
    selfStream: boolean;
    selfVideo: boolean;
    sessionId: string;
    suppress: boolean;
    requestToSpeakTimestamp: string | null;
}

const FLAG_RESET_MS = 3000;
const INTERNAL_RECONNECT_FLAG_MS = 1500;
const RECONNECT_CHECK_DELAY_MS = 250;
const RECONNECT_ATTEMPT_DELAY_MS = 120;
const RECONNECT_COOLDOWN_MS = 5000;
const RECONNECT_ATTEMPT_WINDOW_MS = 20000;
const MAX_RECONNECT_ATTEMPTS_IN_WINDOW = 3;

// Variables de controle (anti-boucle)
let isVoluntaryDisconnect = false;
let disconnectTimeout: NodeJS.Timeout | null = null;
let isChannelSwitching = false;
let switchTimeout: NodeJS.Timeout | null = null;
let reconnectCheckTimeout: NodeJS.Timeout | null = null;
let internalReconnectFlagTimeout: NodeJS.Timeout | null = null;

let internalReconnectInProgress = false;
let pendingReconnectChannelId: string | null = null;
let lastReconnectAttemptAt = 0;
let reconnectWindowStart = 0;
let reconnectAttemptsInWindow = 0;

let originalSelectVoiceChannel: any = null;

// Fonction pour marquer une déconnexion comme volontaire
function markVoluntaryDisconnect() {
    isVoluntaryDisconnect = true;
    console.log("[AntiDéco] Déconnexion volontaire marquée");
    if (disconnectTimeout) clearTimeout(disconnectTimeout);
    disconnectTimeout = setTimeout(() => {
        isVoluntaryDisconnect = false;
        console.log("[AntiDéco] Flag de déconnexion volontaire reseté");
    }, FLAG_RESET_MS);
}

// Fonction pour marquer un changement de canal
function markChannelSwitch() {
    isChannelSwitching = true;
    console.log("[AntiDéco] Changement de canal en cours");
    if (switchTimeout) clearTimeout(switchTimeout);
    switchTimeout = setTimeout(() => {
        isChannelSwitching = false;
        console.log("[AntiDéco] Flag de changement de canal reseté");
    }, FLAG_RESET_MS);
}

function markInternalReconnect() {
    internalReconnectInProgress = true;
    if (internalReconnectFlagTimeout) clearTimeout(internalReconnectFlagTimeout);
    internalReconnectFlagTimeout = setTimeout(() => {
        internalReconnectInProgress = false;
    }, INTERNAL_RECONNECT_FLAG_MS);
}

function canAttemptReconnect() {
    const now = Date.now();

    if (now - lastReconnectAttemptAt < RECONNECT_COOLDOWN_MS) {
        return false;
    }

    if (now - reconnectWindowStart > RECONNECT_ATTEMPT_WINDOW_MS) {
        reconnectWindowStart = now;
        reconnectAttemptsInWindow = 0;
    }

    if (reconnectAttemptsInWindow >= MAX_RECONNECT_ATTEMPTS_IN_WINDOW) {
        return false;
    }

    return true;
}

function registerReconnectAttempt() {
    const now = Date.now();

    if (now - reconnectWindowStart > RECONNECT_ATTEMPT_WINDOW_MS) {
        reconnectWindowStart = now;
        reconnectAttemptsInWindow = 0;
    }

    reconnectAttemptsInWindow++;
    lastReconnectAttemptAt = now;
}

function scheduleReconnect(oldChannelId: string, currentUserId: string) {
    if (pendingReconnectChannelId === oldChannelId) {
        return;
    }

    pendingReconnectChannelId = oldChannelId;

    if (reconnectCheckTimeout) clearTimeout(reconnectCheckTimeout);
    reconnectCheckTimeout = setTimeout(() => {
        try {
            if (isVoluntaryDisconnect || isChannelSwitching || internalReconnectInProgress) {
                pendingReconnectChannelId = null;
                return;
            }

            const currentState = VoiceStateStore.getVoiceStateForUser(currentUserId);
            if (currentState?.channelId) {
                // L'utilisateur est deja reconnecte (ou a change de salon)
                pendingReconnectChannelId = null;
                return;
            }

            if (!canAttemptReconnect()) {
                console.log("[AntiDéco] Reconnexion ignorée (cooldown / limite de tentatives)");
                pendingReconnectChannelId = null;
                return;
            }

            registerReconnectAttempt();

            setTimeout(() => {
                try {
                    markInternalReconnect();
                    console.log(`[AntiDéco] Tentative de reconnexion au salon ${oldChannelId}`);
                    if (originalSelectVoiceChannel) {
                        originalSelectVoiceChannel.call(ChannelActions, oldChannelId);
                    } else {
                        ChannelActions.selectVoiceChannel(oldChannelId);
                    }
                } catch (error) {
                    console.error("[AntiDéco] Erreur lors de la reconnexion:", error);
                } finally {
                    pendingReconnectChannelId = null;
                }
            }, RECONNECT_ATTEMPT_DELAY_MS);
        } catch (error) {
            pendingReconnectChannelId = null;
            console.error("[AntiDéco] Erreur dans scheduleReconnect:", error);
        }
    }, RECONNECT_CHECK_DELAY_MS);
}

export default definePlugin({
    name: "AntiDéconnexion",
    description: "Reconnecte automatiquement au salon vocal en cas de déconnexion forcée",
    authors: [{
        name: "Bash",
        id: 1327483363518582784n
    }],

    // Utilisation du système flux pour écouter les événements vocaux
    flux: {
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: VoiceState[]; }) {
            // Vérification de sécurité pour l'utilisateur actuel
            const currentUser = UserStore.getCurrentUser();
            if (!currentUser) {
                console.warn("[AntiDéco] Utilisateur actuel non disponible");
                return;
            }

            const currentUserId = currentUser.id;

            // Traitement de chaque changement d'état vocal
            for (const state of voiceStates) {
                const { userId, channelId, oldChannelId } = state;

                // On ne s'intéresse qu'aux événements de l'utilisateur actuel
                if (userId !== currentUserId) continue;

                // Détection d'une déconnexion :
                // L'utilisateur était dans un salon (oldChannelId existe)
                // mais n'est plus dans aucun salon (channelId est null/undefined)
                if (oldChannelId && !channelId) {
                    console.log(`[AntiDéco] Déconnexion détectée du salon ${oldChannelId}`);

                    // Vérifier si c'est une déconnexion volontaire
                    if (isVoluntaryDisconnect) {
                        console.log("[AntiDéco] Déconnexion volontaire confirmée, pas de reconnexion");
                        continue;
                    }

                    // Vérifier si c'est un changement de canal en cours
                    if (isChannelSwitching) {
                        console.log("[AntiDéco] Changement de canal en cours, pas de reconnexion");
                        continue;
                    }

                    // Ignorer les événements déclenchés par la reconnexion interne
                    if (internalReconnectInProgress) {
                        console.log("[AntiDéco] Déconnexion liée à une reconnexion interne, ignorée");
                        continue;
                    }

                    console.log(`[AntiDéco] Déconnexion FORCÉE détectée du salon ${oldChannelId}`);
                    scheduleReconnect(oldChannelId, currentUserId);
                }
            }
        },

        // Écouter les actions de déconnexion volontaire
        VOICE_CHANNEL_SELECT({ channelId }: { channelId: string | null; }) {
            if (internalReconnectInProgress) return;

            const currentUser = UserStore.getCurrentUser();
            if (!currentUser) return;

            const currentUserId = currentUser.id;
            const currentVoiceState = VoiceStateStore.getVoiceStateForUser(currentUserId);

            if (currentVoiceState?.channelId) {
                if (channelId === null) {
                    // Déconnexion volontaire
                    console.log("[AntiDéco] Action de déconnexion volontaire détectée via VOICE_CHANNEL_SELECT");
                    markVoluntaryDisconnect();
                } else if (channelId !== currentVoiceState.channelId) {
                    // Changement de canal
                    console.log(`[AntiDéco] Changement de canal détecté via VOICE_CHANNEL_SELECT (${currentVoiceState.channelId} -> ${channelId})`);
                    markChannelSwitch();
                }
            }
        }
    },

    start() {
        console.log("[AntiDéco] Plugin AntiDéconnexion initialisé");

        // Vérification que les stores sont disponibles
        if (!ChannelActions || !VoiceStateStore || !UserStore) {
            console.error("[AntiDéco] Erreur : Stores Discord non disponibles");
            return;
        }

        // Sauvegarder la fonction originale
        originalSelectVoiceChannel = ChannelActions.selectVoiceChannel;

        // Écouter les événements de clic sur le bouton de déconnexion
        ChannelActions.selectVoiceChannel = function (channelId: string | null) {
            if (internalReconnectInProgress) {
                return originalSelectVoiceChannel.call(this, channelId);
            }

            const currentUser = UserStore.getCurrentUser();
            if (!currentUser) return originalSelectVoiceChannel.call(this, channelId);

            const currentUserId = currentUser.id;
            const currentVoiceState = VoiceStateStore.getVoiceStateForUser(currentUserId);

            if (currentVoiceState?.channelId) {
                if (channelId === null) {
                    // Déconnexion volontaire
                    console.log("[AntiDéco] Déconnexion volontaire interceptée via selectVoiceChannel");
                    markVoluntaryDisconnect();
                } else if (channelId !== currentVoiceState.channelId) {
                    // Changement de canal
                    console.log(`[AntiDéco] Changement de canal intercepté via selectVoiceChannel (${currentVoiceState.channelId} -> ${channelId})`);
                    markChannelSwitch();
                }
            }

            return originalSelectVoiceChannel.call(this, channelId);
        };
    },

    stop() {
        console.log("[AntiDéco] Plugin AntiDéconnexion arrêté");

        // Restaurer la fonction originale
        if (originalSelectVoiceChannel && ChannelActions) {
            ChannelActions.selectVoiceChannel = originalSelectVoiceChannel;
            originalSelectVoiceChannel = null;
        }

        if (disconnectTimeout) {
            clearTimeout(disconnectTimeout);
            disconnectTimeout = null;
        }
        if (switchTimeout) {
            clearTimeout(switchTimeout);
            switchTimeout = null;
        }
        if (reconnectCheckTimeout) {
            clearTimeout(reconnectCheckTimeout);
            reconnectCheckTimeout = null;
        }
        if (internalReconnectFlagTimeout) {
            clearTimeout(internalReconnectFlagTimeout);
            internalReconnectFlagTimeout = null;
        }
        isVoluntaryDisconnect = false;
        isChannelSwitching = false;
        internalReconnectInProgress = false;
        pendingReconnectChannelId = null;
        lastReconnectAttemptAt = 0;
        reconnectWindowStart = 0;
        reconnectAttemptsInWindow = 0;
    }
});
