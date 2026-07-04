/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin, { OptionType } from "@utils/types";
import { findComponentByCodeLazy } from "@webpack";
import { ChannelStore, Constants, RestAPI, UserStore } from "@webpack/common";

let PanelButton: any = null;
try {
    PanelButton = findComponentByCodeLazy(".NONE,disabled:", ".PANEL_BUTTON");
} catch {
    try {
        PanelButton = findComponentByCodeLazy(".GREEN,positionKeyStemOverride:");
    } catch {
        PanelButton = null;
    }
}

const settings = definePluginSettings({
    afkEnabled: {
        type: OptionType.BOOLEAN,
        description: "Activer le mode AFK",
        default: false
    },
    autoReplyMessage: {
        type: OptionType.STRING,
        description: "Message automatique envoye quand AFK est actif",
        default: "Je suis actuellement AFK, je te repondrai des que possible."
    },
    secondReplyThreshold: {
        type: OptionType.SLIDER,
        description: "Seuil (nombre de messages recus) pour passer au 2e message AFK",
        default: 2,
        markers: [2, 3, 5, 10, 20],
        minValue: 2,
        maxValue: 50,
        stickToMarkers: false
    },
    secondAutoReplyMessage: {
        type: OptionType.STRING,
        description: "Message AFK a partir du 2e seuil (laisser vide pour garder le message principal)",
        default: "Je suis toujours AFK, je reviens vers toi des que possible."
    },
    thirdReplyThreshold: {
        type: OptionType.SLIDER,
        description: "Seuil (nombre de messages recus) pour passer au 3e message AFK",
        default: 3,
        markers: [3, 5, 10, 20, 30],
        minValue: 3,
        maxValue: 100,
        stickToMarkers: false
    },
    thirdAutoReplyMessage: {
        type: OptionType.STRING,
        description: "Message AFK a partir du 3e seuil (laisser vide pour garder le niveau precedent)",
        default: "Je suis encore AFK, merci pour ta patience."
    },
    replyInDm: {
        type: OptionType.BOOLEAN,
        description: "Repondre automatiquement dans les DM",
        default: true
    },
    replyInGroupDm: {
        type: OptionType.BOOLEAN,
        description: "Repondre automatiquement dans les groupes DM",
        default: true
    },
    replyInGuildWhenMentioned: {
        type: OptionType.BOOLEAN,
        description: "Repondre en serveur uniquement si vous etes mentionne",
        default: true
    },
    muteConversationOnAutoReply: {
        type: OptionType.BOOLEAN,
        description: "Mettre automatiquement en sourdine la conversation apres reponse AFK",
        default: false
    },
    cooldownMs: {
        type: OptionType.SLIDER,
        description: "Cooldown par canal entre deux reponses automatiques (ms)",
        default: 60000,
        markers: [0, 10000, 30000, 60000, 120000],
        minValue: 0,
        maxValue: 300000,
        stickToMarkers: false
    },
    showNotifications: {
        type: OptionType.BOOLEAN,
        description: "Afficher une notification quand le mode AFK change",
        default: true
    }
});

let startTime = 0;
const lastAutoReplyByChannel = new Map<string, number>();
const receivedCountByChannel = new Map<string, number>();
const mutedChannels = new Set<string>();
const FORCED_BUTTON_ID = "vc-afk-forced-toggle";

let domObserver: MutationObserver | null = null;
let domInterval: number | null = null;

function toggleAfk() {
    settings.store.afkEnabled = !settings.store.afkEnabled;

    if (settings.store.afkEnabled) {
        startTime = Date.now();
        lastAutoReplyByChannel.clear();
        receivedCountByChannel.clear();
        mutedChannels.clear();
    }

    if (settings.store.showNotifications) {
        showNotification({
            title: "AFK",
            body: settings.store.afkEnabled ? "Mode AFK active" : "Mode AFK desactive",
            icon: undefined
        });
    }
}

function findUserPanelButtonsContainer(): HTMLElement | null {
    const strictTarget = document.querySelector<HTMLElement>("div[class*='container_'][class*='containerRtcOpened_'] div[class*='buttons_']");
    if (strictTarget) return strictTarget;

    // Fallback: panneau utilisateur sans RTC ouvert
    return document.querySelector<HTMLElement>("div[class*='container_'] div[class*='buttons_']");
}

function applyForcedButtonState(button: HTMLButtonElement) {
    const enabled = settings.store.afkEnabled;

    button.setAttribute("aria-checked", enabled ? "true" : "false");
    button.setAttribute("title", enabled ? "AFK active" : "AFK desactive");

    button.style.color = enabled
        ? "var(--status-danger)"
        : "var(--interactive-normal)";
}

function ensureForcedAfkButton() {
    const container = findUserPanelButtonsContainer();
    if (!container) return;

    let button = document.getElementById(FORCED_BUTTON_ID) as HTMLButtonElement | null;
    if (button && button.parentElement !== container) {
        button.remove();
        button = null;
    }

    if (!button) {
        const sourceButton = container.querySelector<HTMLButtonElement>("button");

        button = document.createElement("button");
        button.id = FORCED_BUTTON_ID;
        button.type = "button";
        button.setAttribute("role", "switch");
        button.setAttribute("aria-label", "Toggle AFK");
        button.className = sourceButton?.className ?? "";

        button.style.minWidth = "36px";
        button.style.padding = "0 10px";
        button.style.fontWeight = "700";
        button.style.letterSpacing = "0.2px";

        const label = document.createElement("span");
        label.textContent = "AFK";
        button.appendChild(label);

        button.addEventListener("click", () => {
            toggleAfk();
            applyForcedButtonState(button!);
        });

        container.appendChild(button);
    }

    applyForcedButtonState(button);
}

function startForcedButtonInjection() {
    ensureForcedAfkButton();

    domObserver = new MutationObserver(() => {
        ensureForcedAfkButton();
    });

    domObserver.observe(document.body, {
        childList: true,
        subtree: true
    });

    domInterval = window.setInterval(() => {
        ensureForcedAfkButton();
    }, 1500);
}

function stopForcedButtonInjection() {
    if (domObserver) {
        domObserver.disconnect();
        domObserver = null;
    }

    if (domInterval !== null) {
        window.clearInterval(domInterval);
        domInterval = null;
    }

    const button = document.getElementById(FORCED_BUTTON_ID);
    button?.remove();
}

function AfkPanelIcon({ enabled }: { enabled: boolean; }) {
    return (
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path
                fill="currentColor"
                d="M12 2a7 7 0 0 0-7 7v5l-1.5 2a1 1 0 0 0 .8 1.6h15.4a1 1 0 0 0 .8-1.6L19 14V9a7 7 0 0 0-7-7Zm0 20a3 3 0 0 0 2.82-2H9.18A3 3 0 0 0 12 22Z"
                style={{ opacity: enabled ? 1 : 0.55 }}
            />
            {enabled && (
                <circle cx="18" cy="6" r="3" fill="var(--status-danger)" />
            )}
        </svg>
    );
}

function AfkPanelButton(props: { nameplate?: any; }) {
    const { afkEnabled } = settings.use(["afkEnabled"]);

    if (!PanelButton) return null;

    return (
        <PanelButton
            tooltipText={afkEnabled ? "AFK active" : "AFK desactive"}
            icon={() => <AfkPanelIcon enabled={afkEnabled} />}
            onClick={toggleAfk}
            plated={props?.nameplate != null}
        />
    );
}

function getMessageChannelId(message: any): string | null {
    return message?.channel_id ?? message?.channelId ?? null;
}

function getMessageTimestampMs(message: any): number {
    if (!message?.timestamp) return Date.now();
    const ts = new Date(message.timestamp).getTime();
    return Number.isFinite(ts) ? ts : Date.now();
}

function isMentioningCurrentUser(message: any, currentUserId: string): boolean {
    if (!message) return false;

    const mentions = Array.isArray(message.mentions) ? message.mentions : [];
    if (mentions.some((m: any) => m?.id === currentUserId)) return true;

    const content = String(message.content ?? "");
    return content.includes(`<@${currentUserId}>`) || content.includes(`<@!${currentUserId}>`);
}

function resolveAutoReplyContent(messageCount: number): string {
    const first = String(settings.store.autoReplyMessage ?? "").trim();
    const second = String(settings.store.secondAutoReplyMessage ?? "").trim();
    const third = String(settings.store.thirdAutoReplyMessage ?? "").trim();

    const secondThreshold = Math.max(2, Number(settings.store.secondReplyThreshold) || 2);
    const rawThirdThreshold = Math.max(3, Number(settings.store.thirdReplyThreshold) || 3);
    const thirdThreshold = Math.max(rawThirdThreshold, secondThreshold + 1);

    if (messageCount >= thirdThreshold) {
        if (third) return third;
        if (second) return second;
        return first;
    }

    if (messageCount >= secondThreshold) {
        if (second) return second;
        return first;
    }

    return first;
}

async function sendAutoReplyForCount(channelId: string, messageCount: number): Promise<void> {
    const content = resolveAutoReplyContent(messageCount);
    if (!content) return;

    await RestAPI.post({
        url: Constants.Endpoints.MESSAGES(channelId),
        body: { content }
    });
}

function resolveChannelSettingsEndpoint(channelId: string): string {
    const endpoints = (Constants as any)?.Endpoints;
    const fn = endpoints?.USER_CHANNEL_SETTINGS;
    if (typeof fn === "function") {
        return fn(channelId);
    }

    // Fallback le plus courant pour les parametres de canal utilisateur.
    return `/users/@me/channels/${channelId}`;
}

async function muteConversation(channelId: string): Promise<void> {
    if (mutedChannels.has(channelId)) return;

    const url = resolveChannelSettingsEndpoint(channelId);
    await RestAPI.patch({
        url,
        body: {
            muted: true
        }
    });

    mutedChannels.add(channelId);
}

export default definePlugin({
    name: "AFK",
    description: "Mode AFK toggle avec reponse automatique en DM et en serveur",
    authors: [{
        name: "Bash",
        id: 1327483363518582784n
    }],
    patches: [
        {
            find: ".DISPLAY_NAME_STYLES_COACHMARK),",
            replacement: {
                match: /(children:\[)(.{0,150}?)(accountContainerRef)/,
                replace: "$1$self.AfkPanelButton(arguments[0]),$2$3"
            }
        },
        {
            find: "#{intl::ACCOUNT_SPEAKING_WHILE_MUTED}",
            replacement: {
                match: /className:\i\.buttons,.{0,50}children:\[/,
                replace: "$&$self.AfkPanelButton(),"
            }
        }
    ],
    settings,

    start() {
        startTime = Date.now();
        lastAutoReplyByChannel.clear();
        receivedCountByChannel.clear();
        mutedChannels.clear();
        startForcedButtonInjection();
    },

    stop() {
        lastAutoReplyByChannel.clear();
        receivedCountByChannel.clear();
        mutedChannels.clear();
        stopForcedButtonInjection();
    },

    AfkPanelButton: ErrorBoundary.wrap(AfkPanelButton, { noop: true }),

    flux: {
        async MESSAGE_CREATE({ message }: { message: any; }) {
            const me = UserStore.getCurrentUser();
            const myId = me?.id;
            if (!myId || !message) return;

            const authorId = message.author?.id;
            const isOwnMessage = authorId === myId;
            if (isOwnMessage) return;

            if (!settings.store.afkEnabled) return;
            if (message.author?.bot) return;

            const timestamp = getMessageTimestampMs(message);
            if (timestamp < startTime) return;

            const channelId = getMessageChannelId(message);
            if (!channelId) return;

            const messageCount = (receivedCountByChannel.get(channelId) ?? 0) + 1;
            receivedCountByChannel.set(channelId, messageCount);

            const channel = ChannelStore.getChannel(channelId);
            const channelType = channel?.type;

            let shouldReply = false;

            if (channelType === 1) {
                shouldReply = settings.store.replyInDm;
            } else if (channelType === 3) {
                shouldReply = settings.store.replyInGroupDm;
            } else {
                shouldReply = settings.store.replyInGuildWhenMentioned && isMentioningCurrentUser(message, myId);
            }

            if (!shouldReply) return;

            const now = Date.now();
            const lastReplyAt = lastAutoReplyByChannel.get(channelId) ?? 0;
            if (now - lastReplyAt < settings.store.cooldownMs) return;

            try {
                await sendAutoReplyForCount(channelId, messageCount);
                lastAutoReplyByChannel.set(channelId, now);

                if (settings.store.muteConversationOnAutoReply) {
                    try {
                        await muteConversation(channelId);
                    } catch (muteError) {
                        console.warn("[Afk] Impossible de mettre la conversation en sourdine:", muteError);
                    }
                }
            } catch (error) {
                console.error("[Afk] Erreur envoi reponse automatique:", error);
            }
        }
    }
});
