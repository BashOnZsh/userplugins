/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { findByProps, find } from "@webpack";
import { React, useState } from "@webpack/common";
import { Forms } from "@webpack/common";

let originalVoiceStateUpdate: any;
let patchedGatewayConnection: any;
let fakeDeafenEnabled = false;
let gatewayMethodName = "voiceStateUpdate";


let ChannelStore: any;
let SelectedChannelStore: any;
let GatewayConnection: any;
let MediaEngineStore: any;

const failedLookups = new Set<string>();

function safeFindByProps<T = any>(...props: string[]): T | null {
    const lookupKey = props.join("|");
    if (failedLookups.has(lookupKey)) {
        return null;
    }

    try {
        const mod = find((m: any) => m && typeof m === "object" && props.every(p => m[p] !== undefined));
        if (mod) return mod as T;
    } catch {}

    failedLookups.add(lookupKey);
    return null;
}

function resolveGatewayConnection() {
    let mod = find((m: any) => m && typeof m === "object" && typeof m.updateVoiceState === "function");
    if (mod) {
        gatewayMethodName = "updateVoiceState";
        return mod;
    }

    mod = find((m: any) => m && typeof m === "object" && typeof m.voiceStateUpdate === "function");
    if (mod) {
        gatewayMethodName = "voiceStateUpdate";
        return mod;
    }

    // Try finding via getSocket() if it exists
    const getSocketMod = find((m: any) => m && typeof m === "object" && typeof m.getSocket === "function");
    if (getSocketMod) {
        const socket = getSocketMod.getSocket();
        if (socket) {
            if (typeof socket.updateVoiceState === "function") {
                gatewayMethodName = "updateVoiceState";
                return socket;
            }
            if (typeof socket.voiceStateUpdate === "function") {
                gatewayMethodName = "voiceStateUpdate";
                return socket;
            }
        }
    }

    return null;
}

function resolveRuntimeModules() {
    ChannelStore = ChannelStore
        ?? safeFindByProps("getChannel", "getDMFromUserId")
        ?? safeFindByProps("getChannel");

    SelectedChannelStore = SelectedChannelStore
        ?? safeFindByProps("getVoiceChannelId")
        ?? safeFindByProps("getVoiceChannelId", "getChannelId");

    MediaEngineStore = MediaEngineStore
        ?? safeFindByProps("isDeaf", "isMute")
        ?? safeFindByProps("isSelfDeaf", "isSelfMute");

    GatewayConnection = GatewayConnection ?? resolveGatewayConnection();
}

function patchGatewayConnection() {
    if (!GatewayConnection || typeof GatewayConnection[gatewayMethodName] !== "function") return false;
    if (patchedGatewayConnection === GatewayConnection && originalVoiceStateUpdate) return true;

    originalVoiceStateUpdate = GatewayConnection[gatewayMethodName];
    patchedGatewayConnection = GatewayConnection;
    GatewayConnection[gatewayMethodName] = function (args: any) {
        if (fakeDeafenEnabled && args && typeof args === "object") {
            args.selfMute = true;
            args.selfDeaf = true;
        }
        return originalVoiceStateUpdate.apply(this, arguments);
    };

    return true;
}

function getSelfMuteState() {
    return MediaEngineStore?.isMute?.() ?? MediaEngineStore?.isSelfMute?.() ?? false;
}

function getSelfDeafState() {
    return MediaEngineStore?.isDeaf?.() ?? MediaEngineStore?.isSelfDeaf?.() ?? false;
}

function getCurrentVoiceChannel() {
    const channelId = SelectedChannelStore?.getVoiceChannelId?.() ?? SelectedChannelStore?.getChannelId?.();
    return channelId ? ChannelStore?.getChannel?.(channelId) : null;
}

function ensureRuntimeReadyForToggle() {
    resolveRuntimeModules();
    if (!patchGatewayConnection()) return false;
    return Boolean(ChannelStore && SelectedChannelStore && typeof GatewayConnection?.[gatewayMethodName] === "function");
}

function KeybindRecorder() {
    const [isRecording, setIsRecording] = useState(false);
    const [keybind, setKeybind] = useState(settings.store.keybind || "Ctrl+Shift+D");

    React.useEffect(() => {
        if (!isRecording) return;

        const handleKeyDown = (e: KeyboardEvent) => {
            e.preventDefault();
            e.stopPropagation();

            // Ignorer les touches modificatrices seules
            if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;

            const keys: string[] = [];
            if (e.ctrlKey) keys.push("Ctrl");
            if (e.shiftKey) keys.push("Shift");
            if (e.altKey) keys.push("Alt");

            // Ajouter la touche principale
            const mainKey = e.key.length === 1 ? e.key.toUpperCase() : e.key;
            keys.push(mainKey);

            const newKeybind = keys.join("+");
            setKeybind(newKeybind);
            settings.store.keybind = newKeybind;
            setIsRecording(false);
        };

        document.addEventListener("keydown", handleKeyDown, true);
        return () => document.removeEventListener("keydown", handleKeyDown, true);
    }, [isRecording]);

    return (
        <Forms.FormSection>
            <Forms.FormTitle tag="h3">Raccourci clavier</Forms.FormTitle>
            <Forms.FormText>Cliquez sur "Enregistrer" puis appuyez sur la combinaison de touches souhaitée</Forms.FormText>
            <div style={{ display: "flex", gap: "8px", alignItems: "center", marginTop: "8px" }}>
                <input
                    type="text"
                    value={isRecording ? "Appuyez sur une touche..." : keybind}
                    readOnly
                    style={{
                        padding: "8px",
                        borderRadius: "4px",
                        border: "1px solid var(--background-modifier-accent)",
                        backgroundColor: isRecording ? "var(--background-tertiary)" : "var(--background-secondary)",
                        color: "var(--text-normal)",
                        flex: "1",
                        cursor: "default"
                    }}
                />
                <button
                    onClick={() => setIsRecording(!isRecording)}
                    style={{
                        padding: "8px 16px",
                        borderRadius: "4px",
                        border: "none",
                        backgroundColor: isRecording ? "var(--button-danger-background)" : "var(--button-secondary-background)",
                        color: "var(--white)",
                        cursor: "pointer"
                    }}
                >
                    {isRecording ? "Annuler" : "Enregistrer"}
                </button>
            </div>
        </Forms.FormSection>
    );
}

const settings = definePluginSettings({
    keybind: {
        type: OptionType.STRING,
        description: "Raccourci clavier actuel",
        default: "Ctrl+Shift+D",
        hidden: true
    }
});

function handleKeyPress(e: KeyboardEvent) {
    const keybind = settings.store.keybind || "Ctrl+Shift+D";
    const keys = keybind.split("+");

    const needsCtrl = keys.includes("Ctrl");
    const needsShift = keys.includes("Shift");
    const needsAlt = keys.includes("Alt");
    const mainKey = keys[keys.length - 1].toUpperCase();

    if (
        e.ctrlKey === needsCtrl &&
        e.shiftKey === needsShift &&
        e.altKey === needsAlt &&
        e.key.toUpperCase() === mainKey
    ) {
        e.preventDefault();
        e.stopPropagation();

        if (!ensureRuntimeReadyForToggle()) {
            console.warn("[FakeDeafen] Dépendances runtime manquantes, toggle ignoré");
            return;
        }

        const channel = getCurrentVoiceChannel();
        if (!channel) {
            console.warn("[FakeDeafen] Aucun canal vocal valide, toggle ignoré");
            return;
        }

        fakeDeafenEnabled = !fakeDeafenEnabled;

        if (fakeDeafenEnabled) {
            GatewayConnection[gatewayMethodName]({
                channelId: channel.id,
                guildId: channel.guild_id,
                selfMute: true,
                selfDeaf: true
            });
        } else {
            const selfMute = getSelfMuteState();
            const selfDeaf = getSelfDeafState();
            GatewayConnection[gatewayMethodName]({
                channelId: channel.id,
                guildId: channel.guild_id,
                selfMute,
                selfDeaf
            });
        }
    }
}

export default definePlugin({
    name: "FakeDeafen",
    description: "Activez le fake deafen avec un raccourci clavier personnalisable. Vous apparaissez comme assourdis et mutés aux autres, mais vous pouvez toujours entendre et parler.",
    authors: [{ name: "Baᛋh", id: 1462173272962764850 }],
    settings,
    settingsAboutComponent: () => <KeybindRecorder />,
    start() {
        console.log("[FakeDeafen] Plugin démarré - Raccourci:", settings.store.keybind);

        // Resolve and cache runtime modules once at startup.
        resolveRuntimeModules();

        // Add keyboard listener
        document.addEventListener("keydown", handleKeyPress, true);

        // Patch voiceStateUpdate
        if (!patchGatewayConnection()) {
            console.warn(`[FakeDeafen] GatewayConnection.${gatewayMethodName} not found`);
        }
    },

    stop() {
        console.log("[FakeDeafen] Plugin arrêté");

        // Remove keyboard listener
        document.removeEventListener("keydown", handleKeyPress, true);

        // Restore original function using cached reference only.
        if (patchedGatewayConnection && originalVoiceStateUpdate) {
            patchedGatewayConnection[gatewayMethodName] = originalVoiceStateUpdate;
        }

        // Reset state
        fakeDeafenEnabled = false;
        originalVoiceStateUpdate = null;
        patchedGatewayConnection = null;
        ChannelStore = null;
        SelectedChannelStore = null;
        GatewayConnection = null;
        MediaEngineStore = null;
        failedLookups.clear();
    }
});
