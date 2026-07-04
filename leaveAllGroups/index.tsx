/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import { settings as pinDmsSettings } from "@plugins/pinDms";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { Channel } from "@vencord/discord-types";
import { findStoreLazy } from "@webpack";
import { ChannelStore, Menu, RestAPI, showToast, Toasts, UserStore } from "@webpack/common";

// Utiliser PrivateChannelSortStore comme dans les autres plugins
const PrivateChannelSortStore = findStoreLazy("PrivateChannelSortStore") as { getPrivateChannelIds: () => string[]; };

const settings = definePluginSettings({
    showNotifications: {
        type: OptionType.BOOLEAN,
        description: "Afficher les notifications/toasts lors des actions",
        default: true
    },
    confirmBeforeLeave: {
        type: OptionType.BOOLEAN,
        description: "Demander confirmation avant de quitter tous les groupes",
        default: false
    },
    leaveSilently: {
        type: OptionType.BOOLEAN,
        description: "Activer 'Quitter sans en informer les autres membres' par défaut",
        default: true
    },
    excludePinnedGroups: {
        type: OptionType.BOOLEAN,
        description: "Exclure les groupes épinglés (plugin PinDMs)",
        default: true
    },
    delayBetweenLeaves: {
        type: OptionType.NUMBER,
        description: "Délai en millisecondes entre chaque sortie de groupe (pour éviter le rate limiting)",
        default: 200,
        min: 50,
        max: 5000
    },
    debugMode: {
        type: OptionType.BOOLEAN,
        description: "Mode débogage (logs détaillés)",
        default: false
    }
});

// Fonction de log avec préfixe
function log(message: string, level: "info" | "warn" | "error" = "info") {
    const timestamp = new Date().toLocaleTimeString();
    const prefix = `[LeaveAllGroups ${timestamp}]`;

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

// Log de débogage
function debugLog(message: string) {
    if (settings.store.debugMode) {
        log(`🔍 ${message}`);
    }
}

function notify(title: string, body: string, toastType?: string, toastBody?: string) {
    if (!settings.store.showNotifications) return;

    showNotification({
        title,
        body,
        icon: undefined
    });

    if (toastType != null && toastBody) {
        showToast(toastBody, toastType);
    }
}

// Fonction pour confirmer l'action
function confirmLeaveAll(groupCount: number): boolean {
    if (!settings.store.confirmBeforeLeave) return true;

    return confirm(
        `⚠️ Êtes-vous sûr de vouloir quitter tous les ${groupCount} groupes ?\n\n` +
        "Cette action ne peut pas être annulée.\n" +
        "Vous serez retiré de tous les groupes Discord instantanément."
    );
}

// Fonction pour quitter un groupe spécifique
async function leaveGroup(channelId: string): Promise<boolean> {
    try {
        debugLog(`Tentative de sortie du groupe ${channelId}`);

        // Utiliser l'API Discord pour quitter le groupe
        await RestAPI.del({
            url: `/channels/${channelId}`,
            query: {
                // Discord option: "Quitter sans en informer les autres membres"
                silent: settings.store.leaveSilently
            }
        });

        debugLog(`✅ Groupe ${channelId} quitté avec succès`);
        return true;
    } catch (error) {
        log(`❌ Erreur lors de la sortie du groupe ${channelId}: ${error}`, "error");
        return false;
    }
}

// Fonction pour obtenir tous les groupes
function getAllGroups(): Channel[] {
    const privateChannelIds = PrivateChannelSortStore.getPrivateChannelIds();
    const groups: Channel[] = [];

    privateChannelIds.forEach((channelId: string) => {
        const channel = ChannelStore.getChannel(channelId);

        // Vérifier que c'est un groupe DM (type 3) et non un DM privé (type 1)
        if (channel && channel.type === 3) {
            groups.push(channel);
        }
    });

    return groups;
}

function getPinnedChannelIdsForUser(userId: string): Set<string> {
    const categoryList = pinDmsSettings.store.userBasedCategoryList[userId] ?? [];
    const pinnedIds = categoryList.flatMap(category => category.channels ?? []);
    return new Set(pinnedIds);
}

// Fonction principale pour quitter tous les groupes
async function leaveAllGroups() {
    try {
        const currentUserId = UserStore.getCurrentUser()?.id;

        if (!currentUserId) {
            log("Impossible d'obtenir l'ID de l'utilisateur actuel", "error");
            return;
        }

        const allGroups = getAllGroups();
        const pinnedChannelIds = settings.store.excludePinnedGroups
            ? getPinnedChannelIdsForUser(currentUserId)
            : new Set<string>();

        const groups = allGroups.filter(group => !pinnedChannelIds.has(group.id));
        const excludedPinnedCount = allGroups.length - groups.length;

        debugLog(`📊 Informations:
- Nombre de groupes trouvés: ${allGroups.length}
- Groupes épinglés exclus: ${excludedPinnedCount}
- Utilisateur actuel: ${currentUserId}`);

        if (groups.length === 0) {
            const emptyMessage = excludedPinnedCount > 0
                ? "Aucun groupe à quitter (tous les groupes trouvés sont épinglés)"
                : "Aucun groupe à quitter";

            log(emptyMessage, "warn");
            notify("ℹ️ LeaveAllGroups", emptyMessage, Toasts.Type.MESSAGE, `ℹ️ ${emptyMessage}`);
            return;
        }

        // Demander confirmation
        if (!confirmLeaveAll(groups.length)) {
            log("Action annulée par l'utilisateur");
            return;
        }

        log(`🚀 Début de la sortie de ${groups.length} groupe(s)${excludedPinnedCount > 0 ? ` (${excludedPinnedCount} épinglé(s) exclu(s))` : ""}`);

        let successCount = 0;
        let failureCount = 0;

        notify(
            "🔄 LeaveAllGroups en cours",
            `Sortie de ${groups.length} groupe(s) en cours...`,
            Toasts.Type.MESSAGE,
            `🔄 Sortie de ${groups.length} groupe(s) en cours...`
        );

        // Quitter chaque groupe
        for (const group of groups) {
            const groupName = group.name || `Groupe ${group.id}`;
            debugLog(`Traitement du groupe: ${groupName} (${group.id})`);

            const success = await leaveGroup(group.id);
            if (success) {
                successCount++;
                debugLog(`✅ Quitté: ${groupName}`);
            } else {
                failureCount++;
                debugLog(`❌ Échec: ${groupName}`);
            }

            // Délai pour éviter le rate limiting
            if (settings.store.delayBetweenLeaves > 0) {
                await new Promise(resolve => setTimeout(resolve, settings.store.delayBetweenLeaves));
            }
        }

        const totalProcessed = successCount + failureCount;

        log(`✅ Opération terminée:
- Groupes traités: ${totalProcessed}
- Succès: ${successCount}
- Échecs: ${failureCount}`);

        const title = failureCount > 0 ? "⚠️ LeaveAllGroups terminé avec erreurs" : "✅ LeaveAllGroups terminé";
        const body = failureCount > 0
            ? `${successCount} groupes quittés, ${failureCount} échecs`
            : `${successCount} groupes quittés avec succès`;

        if (failureCount > 0) {
            notify(title, body, Toasts.Type.FAILURE, `⚠️ ${successCount} groupes quittés, ${failureCount} échecs`);
        } else {
            notify(title, body, Toasts.Type.SUCCESS, `✅ ${successCount} groupes quittés avec succès`);
        }

    } catch (error) {
        log(`❌ Erreur générale: ${error}`, "error");

        notify(
            "❌ LeaveAllGroups - Erreur",
            "Une erreur est survenue lors de la sortie des groupes",
            Toasts.Type.FAILURE,
            "❌ Erreur lors de la sortie des groupes"
        );
    }
}

// Menu contextuel pour les groupes
const GroupContextMenuPatch: NavContextMenuPatchCallback = (children, { channel }: { channel: Channel; }) => {
    // Vérifier que c'est un groupe DM
    if (channel?.type !== 3) return;

    const container = findGroupChildrenByChildId("leave-channel", children);

    if (container) {
        container.push(
            <Menu.MenuItem
                id="vc-leave-all-groups"
                label="🚪 Quitter tous les groupes"
                action={leaveAllGroups}
                color="danger"
            />
        );
    }
};

// Menu contextuel pour les serveurs (accès global)
const ServerContextMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    const group = findGroupChildrenByChildId("privacy", children);

    if (group) {
        group.push(
            <Menu.MenuItem
                id="vc-leave-all-groups-server"
                label="🚪 Quitter tous les groupes"
                action={leaveAllGroups}
                color="danger"
            />
        );
    }
};

// Menu contextuel pour les utilisateurs (accès depuis profil)
const UserContextMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    const container = findGroupChildrenByChildId("block", children) || findGroupChildrenByChildId("remove-friend", children);

    if (container) {
        container.push(
            <Menu.MenuItem
                id="vc-leave-all-groups-user"
                label="🚪 Quitter tous les groupes"
                action={leaveAllGroups}
                color="danger"
            />
        );
    }
};

export default definePlugin({
    name: "LeaveAllGroups",
    description: "Permet de quitter tous les groupes Discord d'un seul clic avec rate limiting configurable",
    authors: [Devs.BigDuck],
    settings,

    contextMenus: {
        "gdm-context": GroupContextMenuPatch,
        "guild-context": ServerContextMenuPatch,
        "user-context": UserContextMenuPatch
    },

    start() {
        log("Plugin LeaveAllGroups démarré");
    },

    stop() {
        log("Plugin LeaveAllGroups arrêté");
    }
});
