/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { Notice } from "@components/Notice";
import { EquicordDevs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { Channel, User, VoiceState } from "@vencord/discord-types";
import { findByPropsLazy, findStoreLazy } from "@webpack";
import { Menu, React, VoiceStateStore } from "@webpack/common";

type TFollowedUserInfo = {
    lastChannelId: string;
    userId: string;
} | null;

interface UserContextProps {
    channel: Channel;
    user: User;
    guildId?: string;
}

let followedUserInfo: TFollowedUserInfo = null;

// Helper function for logging
const logDebug = (message: string, data?: any) => {
    console.log(`[FollowVoiceUser] ${message}`, data ?? "");
};

const logError = (message: string, error?: any) => {
    console.error(`[FollowVoiceUser] ERROR: ${message}`, error ?? "");
};

// Safe initializers with error handling
let voiceChannelAction: any;
let UserStore: any;

try {
    voiceChannelAction = findByPropsLazy("selectVoiceChannel");
    if (!voiceChannelAction || !voiceChannelAction.selectVoiceChannel) {
        throw new Error("selectVoiceChannel action not found");
    }
    logDebug("Voice channel action loaded successfully");
} catch (err) {
    logError("Failed to load voice channel action", err);
}

try {
    UserStore = findStoreLazy("UserStore");
    if (!UserStore) {
        throw new Error("UserStore not found");
    }
    logDebug("UserStore loaded successfully");
} catch (err) {
    logError("Failed to load UserStore", err);
}

const settings = definePluginSettings({
    leaveWhenUserLeaves: {
        type: OptionType.BOOLEAN,
        default: false,
        description: "Leave the voice channel when the user leaves. (That can cause you to sometimes enter infinite leave/join loop)"
    },
    showNotifications: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Show notifications when following/unfollowing users"
    },
    enableDebugLogging: {
        type: OptionType.BOOLEAN,
        default: false,
        description: "Enable debug logging in console for troubleshooting"
    }
});

const UserContextMenuPatch: NavContextMenuPatchCallback = (children, { channel, user }: UserContextProps) => {
    try {
        // Skip if it's the current user
        if (!UserStore || !user?.id) {
            logError("UserStore or user is not available");
            return;
        }

        const currentUser = UserStore.getCurrentUser();
        if (!currentUser || currentUser.id === user.id) {
            return;
        }

        const [checked, setChecked] = React.useState(followedUserInfo?.userId === user.id);

        const handleToggleFollowing = () => {
            try {
                // Check if already following this user
                if (followedUserInfo?.userId === user.id) {
                    followedUserInfo = null;
                    setChecked(false);

                    if (settings.store.enableDebugLogging) {
                        logDebug(`Stopped following user: ${user.username} (${user.id})`);
                    }

                    if (settings.store.showNotifications) {
                        console.log(`[FollowVoiceUser] Stopped following ${user.username}`);
                    }
                    return;
                }

                // Get target user's voice state
                if (!VoiceStateStore) {
                    throw new Error("VoiceStateStore is not available");
                }

                const userVoiceState = VoiceStateStore.getVoiceStateForUser(user.id);
                const targetChannelId = userVoiceState?.channelId;

                if (!targetChannelId) {
                    logDebug(`User ${user.username} is not in a voice channel`);
                    if (settings.store.showNotifications) {
                        console.warn(`[FollowVoiceUser] ${user.username} is not in a voice channel`);
                    }
                    // Still mark as following, but don't join yet
                }

                // Set following info
                followedUserInfo = {
                    lastChannelId: targetChannelId || "",
                    userId: user.id
                };

                // Join the voice channel if available
                if (targetChannelId && voiceChannelAction && voiceChannelAction.selectVoiceChannel) {
                    voiceChannelAction.selectVoiceChannel(targetChannelId);
                    logDebug(`Joining channel: ${targetChannelId} to follow ${user.username}`);
                } else {
                    logDebug(`Now following ${user.username} (currently not in a voice channel, will join when they move)`);
                }

                if (settings.store.showNotifications) {
                    console.log(`[FollowVoiceUser] Now following ${user.username}`);
                }

                setChecked(true);
            } catch (err) {
                logError("Failed to toggle following", err);
                setChecked(false);
                if (settings.store.showNotifications) {
                    console.error(`[FollowVoiceUser] Error while following user: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
        };

        children.push(
            <Menu.MenuSeparator />,
            <Menu.MenuCheckboxItem
                id="fvu-follow-user"
                label="Follow User"
                checked={checked}
                action={handleToggleFollowing}
            ></Menu.MenuCheckboxItem>
        );
    } catch (err) {
        logError("Error in UserContextMenuPatch", err);
    }
};

export default definePlugin({
    name: "FollowVoiceUser",
    description: "Follow a user in voice chat.",
    authors: [EquicordDevs.TheArmagan],
    settings,
    settingsAboutComponent: () => (
        <Notice.Info>
            This Plugin is used to follow users into voice chat(s).
        </Notice.Info>
    ),
    flux: {
        async VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: VoiceState[]; }) {
            try {
                // Validate dependencies
                if (!followedUserInfo || !voiceStates || voiceStates.length === 0) {
                    return;
                }

                if (!VoiceStateStore || !UserStore || !voiceChannelAction) {
                    throw new Error("Required stores or actions are not available");
                }

                // Get current user info
                const currentUser = UserStore.getCurrentUser();
                if (!currentUser) {
                    throw new Error("Could not get current user");
                }

                // Get current user's voice status
                const currentUserVoiceState = VoiceStateStore.getVoiceStateForUser(currentUser.id);
                const isCurrentUserInVoice = !!currentUserVoiceState?.channelId;

                // Process voice states
                voiceStates.forEach(voiceState => {
                    try {
                        if (!voiceState || voiceState.userId !== followedUserInfo!.userId) {
                            return;
                        }

                        // User moved to a different voice channel
                        if (voiceState.channelId && voiceState.channelId !== followedUserInfo!.lastChannelId) {
                            if (settings.store.enableDebugLogging) {
                                logDebug(`Followed user moved to channel: ${voiceState.channelId}`);
                            }

                            followedUserInfo!.lastChannelId = voiceState.channelId;

                            // Only join if we're in a voice channel (required by Discord)
                            if (isCurrentUserInVoice && voiceChannelAction.selectVoiceChannel) {
                                voiceChannelAction.selectVoiceChannel(voiceState.channelId);
                                logDebug(`Successfully joined channel: ${voiceState.channelId}`);
                            } else if (!isCurrentUserInVoice && settings.store.enableDebugLogging) {
                                logDebug(`Cannot join channel: current user is not in a voice channel. Will join when you enter voice.`);
                            } else if (!voiceChannelAction.selectVoiceChannel) {
                                throw new Error("selectVoiceChannel method not available");
                            }
                        }
                        // User left voice channel
                        else if (!voiceState.channelId && followedUserInfo!.lastChannelId !== "") {
                            followedUserInfo!.lastChannelId = "";
                            
                            if (settings.store.leaveWhenUserLeaves) {
                                if (settings.store.enableDebugLogging) {
                                    logDebug("Followed user left voice channel, leaving as well");
                                }

                                if (isCurrentUserInVoice && voiceChannelAction.selectVoiceChannel) {
                                    voiceChannelAction.selectVoiceChannel(null);
                                    logDebug("Successfully left voice channel");
                                } else if (!isCurrentUserInVoice && settings.store.enableDebugLogging) {
                                    logDebug(`Not in voice channel, cannot leave channel.`);
                                }
                            }
                        }
                    } catch (err) {
                        logError(`Error processing voice state for user ${voiceState?.userId}`, err);
                    }
                });
            } catch (err) {
                logError("Error in VOICE_STATE_UPDATES handler", err);
                // Reset following state on critical errors
                if (err instanceof Error && err.message.includes("not available")) {
                    logError("Critical error: resetting following state due to unavailable stores/actions");
                    followedUserInfo = null;
                }
            }
        }
    },
    contextMenus: {
        "user-context": UserContextMenuPatch
    }
});
