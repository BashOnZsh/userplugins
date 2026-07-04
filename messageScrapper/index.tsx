/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType } from "@api/Commands";
import { EquicordDevs } from "@utils/constants";
import definePlugin from "@utils/types";
import { ChannelStore, Constants, RestAPI, SelectedChannelStore, showToast, Toasts } from "@webpack/common";

let shouldBlockNextMessage = false;

export default definePlugin({
    name: "ScrapMessageUltraSilent",
    description: "Scrape DM → téléchargement TXT uniquement, zéro message ajouté",
    authors: [EquicordDevs.SteelTech],

    patches: [
        {
            find: "trackWithMetadata:function",
            replacement: {
                match: /(sendMessage:\i\(\i,\i,(\i)){/,
                replace: "$1{if($self.shouldBlock($2))return;",
            }
        }
    ],

    shouldBlock(message: any) {
        if (shouldBlockNextMessage && message.content?.startsWith("/scrapmessage")) {
            shouldBlockNextMessage = false;
            return true;
        }
        return false;
    },

    commands: [{
        name: "scrapmessage",
        description: "Exporte les messages en TXT (aucune trace visible)",
        inputType: ApplicationCommandInputType.BUILT_IN,
        execute: async () => {
            shouldBlockNextMessage = true;

            const channelId = SelectedChannelStore.getChannelId();
            if (!channelId) {
                showToast("❌ Aucun canal sélectionné", Toasts.Type.FAILURE);
                return;
            }

            const channel = ChannelStore.getChannel(channelId);
            if (!channel?.isDM() && !channel?.isGroupDM()) {
                showToast("❌ Fonctionne uniquement dans les DM et groupes", Toasts.Type.FAILURE);
                return;
            }

            showToast("🔄 Chargement de tous les messages...", Toasts.Type.MESSAGE);

            // Récupération de TOUS les messages via pagination
            const allMessages: any[] = [];
            let oldestId: string | undefined;
            let batchCount = 0;
            const BATCH_SIZE = 100; // Limite Discord

            try {
                while (true) {
                    const res = await RestAPI.get({
                        url: Constants.Endpoints.MESSAGES(channelId),
                        query: {
                            limit: BATCH_SIZE,
                            ...(oldestId ? { before: oldestId } : {})
                        },
                        retries: 3
                    });

                    const batch = res.body || [];
                    if (batch.length === 0) break;

                    allMessages.push(...batch);
                    batchCount++;

                    // Mise à jour progression
                    if (batchCount % 5 === 0) {
                        showToast(`🔄 Chargé ${allMessages.length} messages...`, Toasts.Type.MESSAGE);
                    }

                    // Si moins de BATCH_SIZE messages, on a atteint la fin
                    if (batch.length < BATCH_SIZE) break;

                    // ID du plus ancien message pour la prochaine requête
                    oldestId = batch[batch.length - 1].id;

                    // Pause pour éviter rate limit
                    await new Promise(resolve => setTimeout(resolve, 200));
                }
            } catch (error) {
                showToast("❌ Erreur lors du chargement des messages", Toasts.Type.FAILURE);
                console.error("Erreur fetch messages:", error);
                return;
            }

            if (allMessages.length < 1) {
                showToast("❌ Aucun message trouvé", Toasts.Type.FAILURE);
                return;
            }

            // Tri chronologique (plus ancien au plus récent)
            allMessages.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

            let content = "=== CONVERSATION PRIVÉE ===\n";
            content += `ID canal: ${channelId}\n`;
            content += `Export: ${new Date().toLocaleString("fr-FR")}\n`;
            content += `Total messages: ${allMessages.length}\n\n`;

            for (const m of allMessages) {
                if (!m.content?.trim() && !m.attachments?.length && !m.embeds?.length) continue;

                const time = new Date(m.timestamp).toLocaleString("fr-FR");
                const author = m.author?.global_name || m.author?.username || "?";
                const text = m.content?.trim() || "[média ou embed]";

                content += `[${time}] ${author}: ${text}\n`;
            }

            const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const timestamp = Date.now();
            const filename = `dm-${channelId}-${timestamp}.txt`;
            const a = document.createElement("a");
            a.href = url;
            a.download = filename;
            a.style.display = "none";
            document.body.appendChild(a);
            a.click();

            // Nettoyage
            requestAnimationFrame(() => {
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            });

            showToast(`✅ ${allMessages.length} messages exportés (${batchCount} requêtes)`, Toasts.Type.SUCCESS);
        }
    }]
});
