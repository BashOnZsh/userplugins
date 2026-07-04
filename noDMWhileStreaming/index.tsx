import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { findByPropsLazy } from "@webpack";
import { FluxDispatcher, UserStore, ChannelStore, ReadStateUtils, useStateFromStores } from "@webpack/common";

const StreamStore = findByPropsLazy("getActiveStreamForUser", "getAllActiveStreams");
const RTCConnectionStore = findByPropsLazy("getMediaSessionId");
const StreamerModeStore = findByPropsLazy("hidePersonalInformation");

const settings = definePluginSettings({
    debugMode: {
        type: OptionType.BOOLEAN,
        description: "Mode débogage - Affiche des logs détaillés dans la console",
        default: false
    }
});

function isStreaming(): boolean {
    try {
        if (StreamerModeStore?.hidePersonalInformation) {
            return true;
        }

        const currentUser = UserStore?.getCurrentUser?.();
        if (!currentUser) return false;

        const userStream = StreamStore?.getActiveStreamForUser?.(currentUser.id);
        if (userStream) {
            if (settings.store.debugMode) console.log("[NoDMWhileStreaming] [DEBUG] Stream detected via getActiveStreamForUser", userStream);
            return true;
        }

        const allStreams = StreamStore?.getAllActiveStreams?.();
        if (allStreams && allStreams.length > 0) {
            const myStream = allStreams.find((s: any) => s.ownerId === currentUser.id);
            if (myStream) return true;
        }

        const mediaSessionId = RTCConnectionStore?.getMediaSessionId?.();
        if (mediaSessionId) {
            const state = RTCConnectionStore?.getState?.();
            if (state && state.context === "stream") return true;
        }

        return false;
    } catch (e) {
        console.error("[NoDMWhileStreaming] Erreur lors de la vérification du stream:", e);
        return false;
    }
}

export default definePlugin({
    name: "NoDMWhileStreaming",
    description: "Retire l'affichage des notifications de DM dans la barre latérale lorsqu'un stream est lancé",
    authors: [Devs.Unknown],
    settings,
    patches: [
        // Filtre les DMs (type 1) de la liste des canaux privés
        {
            find: '"dm-quick-launcher"===',
            replacement: {
                match: /privateChannelIds:([^,]+)(?=,listRef:)/,
                replace: "privateChannelIds:$self.filterChannels($1)"
            }
        },
        // Hook réactif pour forcer le re-render quand le statut de stream change
        {
            find: ".FRIENDS},\"friends\"",
            replacement: {
                match: /let{showLibrary:\i,/,
                replace: "$self.useStreamStatus();$&"
            }
        }
    ],

    // Flux events — intercepte MESSAGE_CREATE pour auto-ack les DMs pendant le stream
    flux: {
        MESSAGE_CREATE(event: any) {
            if (!isStreaming()) return;

            const message = event?.message;
            if (!message) return;

            const channel = ChannelStore?.getChannel?.(message.channel_id);
            if (!channel) return;

            // Type 1 = DM privé uniquement (on garde les groupes type 3)
            if (channel.type !== 1) return;

            // Ne pas ack ses propres messages
            const currentUser = UserStore?.getCurrentUser?.();
            if (currentUser && message.author?.id === currentUser.id) return;

            if (settings.store.debugMode) {
                console.log(`[NoDMWhileStreaming] [ACK] Auto-ack DM de ${message.author?.username} dans le channel ${message.channel_id}`);
            }

            // Marquer le canal comme lu pour supprimer le badge
            try {
                ReadStateUtils?.ackChannel?.(channel);
            } catch (e) {
                if (settings.store.debugMode) {
                    console.error("[NoDMWhileStreaming] Erreur lors de l'ack:", e);
                }
            }
        }
    },

    useStreamStatus() {
        useStateFromStores([StreamerModeStore, StreamStore], () => isStreaming());
    },

    filterChannels(ids: string[]) {
        const streaming = isStreaming();
        if (settings.store.debugMode) {
            console.log(`[NoDMWhileStreaming] [DEBUG] 🎨 filterChannels appelé. IDs count: ${ids?.length}, Streaming: ${streaming}`);
        }
        if (!streaming) return ids;

        const filtered = ids.filter((id: string) => ChannelStore?.getChannel?.(id)?.type !== 1);
        if (settings.store.debugMode) {
            console.log(`[NoDMWhileStreaming] [DEBUG] 🎨 filterChannels filtré. Reste: ${filtered.length}`);
        }
        return filtered;
    },

    start() {
        if (settings.store.debugMode) console.log("[NoDMWhileStreaming] Plugin démarré");
    },

    stop() {
        if (settings.store.debugMode) console.log("[NoDMWhileStreaming] Plugin arrêté");
    }
});
