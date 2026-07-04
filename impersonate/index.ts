/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandOptionType, sendBotMessage, Argument, CommandContext } from "@api/Commands";
import { ApplicationCommandInputType } from "@api/Commands/types";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import { FluxDispatcher, UserStore, DraftType, SnowflakeUtils, ImageUtils, MessageStore, SelectedChannelStore } from "@webpack/common";
import { findByPropsLazy } from "@webpack";

const logger = new Logger("Impersonate");

const UploadStore = findByPropsLazy("getUpload");

// Store fake messages to re-dispatch them on channel switch for persistence
const fakeMessages: any[] = [];

async function resolveFile(options: Argument[], ctx: CommandContext, name: string): Promise<File | null> {
    const opt = options.find(o => o.name === name);
    if (opt) {
        const upload = UploadStore.getUpload(ctx.channel.id, opt.name, DraftType.SlashCommand);
        return upload?.item?.file || null;
    }
    return null;
}

export default definePlugin({
    name: "Impersonate",
    description: "Impersonate a user and have them send a fake message.",
    authors: [Devs.BigDuck],
    dependencies: ["CommandsAPI"],

    onStart() {
        MessageStore.addChangeListener(this.onStoreChange);
    },

    onStop() {
        MessageStore.removeChangeListener(this.onStoreChange);
        fakeMessages.length = 0;
    },

    // Handle persistence by re-injecting messages if they are missing from the store
    onStoreChange() {
        const channelId = SelectedChannelStore.getChannelId();
        if (!channelId) return;

        const messages = MessageStore.getMessages(channelId);
        if (!messages) return;

        for (const msg of fakeMessages) {
            if (msg.channelId === channelId && !messages.has(msg.message.id)) {
                // Use setTimeout to avoid dispatching during another dispatch
                setTimeout(() => {
                    // Re-check just in case
                    const currentMessages = MessageStore.getMessages(channelId);
                    if (currentMessages && !currentMessages.has(msg.message.id)) {
                        FluxDispatcher.dispatch({
                            type: "MESSAGE_CREATE",
                            ...msg
                        });
                    }
                }, 0);
            }
        }
    },

    commands: [
        {
            name: "impersonate",
            description: "Impersonate a user with a fake message.",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    type: ApplicationCommandOptionType.USER,
                    name: "user",
                    description: "The user you wish to impersonate.",
                    required: true
                },
                {
                    type: ApplicationCommandOptionType.STRING,
                    name: "message",
                    description: "The message you would like this user to say.",
                    required: false
                },
                {
                    type: ApplicationCommandOptionType.CHANNEL,
                    name: "channel",
                    description: "Channel the impersonated message should be sent in.",
                    required: false
                },
                {
                    type: ApplicationCommandOptionType.INTEGER,
                    name: "delay",
                    description: "Delay before the message appears (seconds).",
                    required: false
                },
                {
                    type: ApplicationCommandOptionType.ATTACHMENT,
                    name: "image",
                    description: "Image to attach to the message.",
                    required: false
                },
                {
                    type: ApplicationCommandOptionType.STRING,
                    name: "image_url",
                    description: "URL of an image to attach to the message.",
                    required: false
                },
                {
                    type: ApplicationCommandOptionType.STRING,
                    name: "username",
                    description: "Override the user's username.",
                    required: false
                },
                {
                    type: ApplicationCommandOptionType.ATTACHMENT,
                    name: "avatar",
                    description: "Override the user's avatar with an uploaded image.",
                    required: false
                },
                {
                    type: ApplicationCommandOptionType.STRING,
                    name: "avatar_url",
                    description: "Override the user's avatar with an image URL.",
                    required: false
                }
            ],
            execute: async (args, ctx) => {
                try {
                    const userArg = args.find(x => x.name === "user");
                    const message = args.find(x => x.name === "message")?.value ?? "";
                    const channelArg = args.find(x => x.name === "channel");
                    const delayArg = args.find(x => x.name === "delay");
                    const imageUrl = args.find(x => x.name === "image_url")?.value;
                    const customUsername = args.find(x => x.name === "username")?.value;
                    const customAvatarUrl = args.find(x => x.name === "avatar_url")?.value;

                    const channelId = channelArg?.value ?? ctx.channel.id;
                    const delay = Number(delayArg?.value ?? 0.5);

                    const user = UserStore.getUser(userArg?.value);
                    if (!user && !customUsername) {
                        return sendBotMessage(ctx.channel.id, { content: "User not found." });
                    }

                    const attachmentFile = await resolveFile(args, ctx, "image");
                    const avatarFile = await resolveFile(args, ctx, "avatar");

                    if (!message && !attachmentFile && !imageUrl) {
                        return sendBotMessage(ctx.channel.id, { content: "You must provide a message or an image." });
                    }

                    const attachmentDataUrl = attachmentFile ? await ImageUtils.fileToDataURL(attachmentFile) : null;
                    const avatarDataUrl = avatarFile ? await ImageUtils.fileToDataURL(avatarFile) : null;

                    if (delay > 0 && user) {
                        FluxDispatcher.dispatch({
                            type: "TYPING_START",
                            channelId: channelId,
                            userId: user.id,
                        });
                    }

                    setTimeout(() => {
                        const attachments = [];
                        if (attachmentDataUrl) {
                            attachments.push({
                                id: SnowflakeUtils.fromTimestamp(Date.now()),
                                filename: attachmentFile.name,
                                size: attachmentFile.size,
                                url: attachmentDataUrl,
                                proxy_url: attachmentDataUrl,
                                width: 1000,
                                height: 1000,
                                content_type: attachmentFile.type
                            });
                        } else if (imageUrl) {
                            attachments.push({
                                id: SnowflakeUtils.fromTimestamp(Date.now()),
                                filename: "image.png",
                                size: 0,
                                url: imageUrl,
                                proxy_url: imageUrl,
                                width: 1000,
                                height: 1000,
                                content_type: "image/png"
                            });
                        }

                        const messageId = SnowflakeUtils.fromTimestamp(Date.now());
                        
                        let avatar = user?.avatar;
                        if (avatarDataUrl) {
                            avatar = avatarDataUrl;
                        } else if (customAvatarUrl) {
                            avatar = customAvatarUrl;
                        }

                        const fakeMsgPayload = {
                            channelId: channelId,
                            message: {
                                attachments,
                                author: {
                                    id: user?.id ?? SnowflakeUtils.fromTimestamp(Date.now()),
                                    username: customUsername ?? user?.username ?? "Unknown",
                                    avatar: avatar,
                                    discriminator: user?.discriminator ?? "0000",
                                    public_flags: user?.publicFlags ?? 0,
                                    premium_type: user?.premiumType ?? 0,
                                    flags: user?.flags ?? 0,
                                    banner: user?.banner,
                                    accent_color: null,
                                    // @ts-ignore
                                    global_name: customUsername ?? user?.globalName ?? "Unknown",
                                    // @ts-ignore
                                    avatar_decoration_data: user?.avatarDecorationData ? { 
                                        asset: user.avatarDecorationData.asset, 
                                        sku_id: user.avatarDecorationData.skuId 
                                    } : null,
                                    banner_color: null
                                },
                                channel_id: channelId,
                                components: [],
                                content: message,
                                edited_timestamp: null,
                                embeds: [],
                                flags: 0,
                                id: messageId,
                                mention_everyone: false,
                                mention_roles: [],
                                mentions: [],
                                nonce: messageId,
                                pinned: false,
                                timestamp: new Date().toISOString(),
                                tts: false,
                                type: 0
                            },
                            optimistic: false,
                            isPushNotification: false
                        };

                        fakeMessages.push(fakeMsgPayload);
                        FluxDispatcher.dispatch({
                            type: "MESSAGE_CREATE",
                            ...fakeMsgPayload
                        });
                    }, delay * 1000);

                } catch (error) {
                    logger.error(error);
                    sendBotMessage(ctx.channel.id, {
                        content: `Something went wrong: \`${error}\``,
                    });
                }
            }
        }
    ]
});
