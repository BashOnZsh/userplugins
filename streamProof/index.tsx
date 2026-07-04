/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { findByPropsLazy } from "@webpack";
import { FluxDispatcher } from "@webpack/common";

const StreamStore = findByPropsLazy("getActiveStreamForUser", "getAllActiveStreams");
const UserStore = findByPropsLazy("getCurrentUser");
const RTCConnectionStore = findByPropsLazy("getMediaSessionId");

let styleElement: HTMLStyleElement | null = null;

const settings = definePluginSettings({
    hideEquicord: {
        type: OptionType.BOOLEAN,
        description: "Cacher automatiquement la section Equicord pendant le stream",
        default: true
    },
    hideSettingsButton: {
        type: OptionType.BOOLEAN,
        description: "Cacher aussi le bouton des paramètres Equicord",
        default: true
    },
    customSelectors: {
        type: OptionType.STRING,
        description: "Sélecteurs CSS personnalisés à cacher (séparés par des virgules)",
        default: ""
    },
    debugMode: {
        type: OptionType.BOOLEAN,
        description: "Mode débogage - Affiche des logs détaillés dans la console",
        default: false
    }
});

function isStreaming(): boolean {
    try {
        const currentUser = UserStore?.getCurrentUser?.();
        if (!currentUser) {
            if (settings.store.debugMode) {
                console.log("[StreamProof] Aucun utilisateur trouvé");
            }
            return false;
        }

        // Méthode 1: Vérifier via StreamStore
        const userStream = StreamStore?.getActiveStreamForUser?.(currentUser.id);
        if (userStream) {
            if (settings.store.debugMode) {
                console.log("[StreamProof] Stream détecté via getActiveStreamForUser:", userStream);
            }
            return true;
        }

        // Méthode 2: Vérifier tous les streams actifs
        const allStreams = StreamStore?.getAllActiveStreams?.();
        if (allStreams && allStreams.length > 0) {
            const myStream = allStreams.find((s: any) => s.ownerId === currentUser.id);
            if (myStream) {
                if (settings.store.debugMode) {
                    console.log("[StreamProof] Stream détecté via getAllActiveStreams:", myStream);
                }
                return true;
            }
        }

        // Méthode 3: Vérifier via RTCConnectionStore
        const mediaSessionId = RTCConnectionStore?.getMediaSessionId?.();
        if (mediaSessionId) {
            const state = RTCConnectionStore?.getState?.();
            if (state && state.context === "stream") {
                if (settings.store.debugMode) {
                    console.log("[StreamProof] Stream détecté via RTCConnectionStore");
                }
                return true;
            }
        }

        if (settings.store.debugMode) {
            console.log("[StreamProof] Aucun stream détecté");
        }
        return false;
    } catch (e) {
        console.error("[StreamProof] Erreur lors de la vérification du stream:", e);
        return false;
    }
}

function injectHideCSS() {
    if (styleElement) {
        if (settings.store.debugMode) {
            console.log("[StreamProof] CSS déjà injecté, pas besoin de réinjecter");
        }
        return;
    }

    styleElement = document.createElement("style");
    styleElement.id = "streamproof-hide-css";

    let cssRules = "";

    if (settings.store.hideEquicord) {
        // Cache les éléments Equicord/Vencord courants
        cssRules += `
            /* Cache la section complète Equicord dans la sidebar */
            ul[class*="section"][aria-label*="Equicord" i] {
                display: none !important;
            }

            /* Cache tous les items de menu Equicord */
            div[data-settings-sidebar-item^="equicord_"],
            div[data-settings-sidebar-item*="equicord" i] {
                display: none !important;
            }

            /* Cache les sections avec label Equicord/Vencord */
            [class*="sectionLabel"]:has([data-text-variant*="heading"]:has-text(/Equicord|Vencord/i)),
            div[class*="sectionLabel"]:has(h1:has-text(/Equicord|Vencord/i)) {
                display: none !important;
            }

            /* Sélecteurs de fallback pour d'autres structures */
            [class*="contentRegion"] [class*="sidebar"] [aria-label*="Equicord" i],
            [class*="contentRegion"] [class*="sidebar"] [aria-label*="Vencord" i],
            [class*="item"][class*="themed"]:has([class*="Equicord" i]),
            [class*="item"][class*="themed"]:has([class*="Vencord" i]),
            div[class*="side"] > div[role="tab"]:has([class*="Equicord" i]),
            div[class*="side"] > div[role="tab"]:has([class*="Vencord" i]) {
                display: none !important;
            }

            /* Cache les onglets Equicord/Vencord */
            [class*="item"]:has(> [class*="Equicord" i]),
            [class*="item"]:has(> [class*="Vencord" i]),
            div[id*="Equicord" i],
            div[id*="Vencord" i] {
                display: none !important;
            }

            /* Cache les sections contenant "Equicord x" */
            ul[aria-label*="Equicord x" i] {
                display: none !important;
            }
        `;
    }

    if (settings.store.hideSettingsButton) {
        // Cache le bouton des paramètres Equicord
        cssRules += `
            /* Cache les icônes et boutons Equicord/Vencord dans la barre d'outils */
            [class*="toolbar"] [class*="iconWrapper"]:has(.vc-icon),
            [class*="toolbar"] button:has(.vc-icon),
            [class*="toolbarIcon"]:has([d*="M10.56" i]),
            button[aria-label*="Equicord" i],
            button[aria-label*="Vencord" i],
            [class*="listItem"]:has([aria-label*="Equicord" i]),
            [class*="listItem"]:has([aria-label*="Vencord" i]),
            div[class*="iconWrapper"]:has(svg.vc-icon) {
                display: none !important;
            }

            /* Cache spécifiquement l'icône engrenage d'Equicord */
            svg.vc-icon[viewBox="0 0 24 24"]:has(path[d*="M10.56 1.1" i]) {
                display: none !important;
            }
        `;
    }

    // Ajoute les sélecteurs personnalisés
    if (settings.store.customSelectors && settings.store.customSelectors.trim()) {
        const customSelectors = settings.store.customSelectors
            .split(",")
            .map((s: string) => s.trim())
            .filter((s: string) => s.length > 0)
            .join(", ");

        if (customSelectors) {
            cssRules += `
                /* Sélecteurs personnalisés */
                ${customSelectors} {
                    display: none !important;
                }
            `;
        }
    }

    styleElement.textContent = cssRules;
    document.head.appendChild(styleElement);
    console.log("[StreamProof] 🔒 CSS de masquage injecté - Les éléments Equicord sont maintenant cachés");
    if (settings.store.debugMode) {
        console.log("[StreamProof] Règles CSS appliquées:", cssRules);
    }
}

function removeHideCSS() {
    if (styleElement) {
        styleElement.remove();
        styleElement = null;
        console.log("[StreamProof] 🔓 CSS de masquage retiré - Les éléments Equicord sont à nouveau visibles");
    }
}

function updateHideStatus() {
    const streaming = isStreaming();

    if (settings.store.debugMode) {
        console.log(`[StreamProof] État du stream: ${streaming ? "EN STREAM" : "PAS EN STREAM"}`);
    }

    if (streaming && settings.store.hideEquicord) {
        injectHideCSS();
    } else {
        removeHideCSS();
    }
}

export default definePlugin({
    name: "StreamProof",
    description: "Détecte automatiquement quand vous êtes en stream et cache la section Equicord pour protéger votre vie privée",
    authors: [Devs.Unknown],
    settings,

    start() {
        console.log("[StreamProof] Plugin démarré - Surveillance du stream activée");
        if (settings.store.debugMode) {
            console.log("[StreamProof] Mode débogage activé");
        }

        // Vérification initiale
        updateHideStatus();

        // Écoute les changements d'état du stream
        FluxDispatcher.subscribe("STREAM_CREATE", updateHideStatus);
        FluxDispatcher.subscribe("STREAM_UPDATE", updateHideStatus);
        FluxDispatcher.subscribe("STREAM_DELETE", updateHideStatus);
        FluxDispatcher.subscribe("STREAM_START", updateHideStatus);
        FluxDispatcher.subscribe("STREAM_STOP", updateHideStatus);
        FluxDispatcher.subscribe("STREAM_CLOSE", updateHideStatus);
        FluxDispatcher.subscribe("RTC_CONNECTION_STATE", updateHideStatus);
        FluxDispatcher.subscribe("MEDIA_ENGINE_VIDEO_STATE_UPDATE", updateHideStatus);

        // Vérification périodique de sécurité (toutes les 2 secondes)
        (this as any).checkInterval = setInterval(updateHideStatus, 2000);
    },

    stop() {
        console.log("[StreamProof] Plugin arrêté");

        // Nettoie les écouteurs
        FluxDispatcher.unsubscribe("STREAM_CREATE", updateHideStatus);
        FluxDispatcher.unsubscribe("STREAM_UPDATE", updateHideStatus);
        FluxDispatcher.unsubscribe("STREAM_DELETE", updateHideStatus);
        FluxDispatcher.unsubscribe("STREAM_START", updateHideStatus);
        FluxDispatcher.unsubscribe("STREAM_STOP", updateHideStatus);
        FluxDispatcher.unsubscribe("STREAM_CLOSE", updateHideStatus);
        FluxDispatcher.unsubscribe("RTC_CONNECTION_STATE", updateHideStatus);
        FluxDispatcher.unsubscribe("MEDIA_ENGINE_VIDEO_STATE_UPDATE", updateHideStatus);

        // Arrête la vérification périodique
        if ((this as any).checkInterval) {
            clearInterval((this as any).checkInterval);
            (this as any).checkInterval = null;
        }

        // Retire le CSS de masquage
        removeHideCSS();
    }
});
