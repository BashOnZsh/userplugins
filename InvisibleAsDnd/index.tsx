/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import definePlugin from "@utils/types";
import type { MessageJSON } from "@vencord/discord-types";
import { NotificationSettingsStore, PresenceStore, UserStore } from "@webpack/common";

let originalGetUserAgnosticState: typeof NotificationSettingsStore.getUserAgnosticState | null = null;
let originalTaskbarFlashDescriptor: PropertyDescriptor | null = null;
const originalSoundMethods = new Map<string, Function>();

const SOUND_METHOD_CANDIDATES = [
    "isSoundEnabled",
    "isMessageSoundEnabled",
    "isCallSoundsEnabled",
    "isIncomingCallSoundEnabled",
    "isNotificationSoundEnabled",
    "shouldPlaySound"
];

function patchSoundMethods() {
    const store = NotificationSettingsStore as any;

    for (const methodName of SOUND_METHOD_CANDIDATES) {
        const original = store[methodName];
        if (typeof original !== "function" || originalSoundMethods.has(methodName)) continue;

        originalSoundMethods.set(methodName, original);
        store[methodName] = function (...args: any[]) {
            if (isInvisible()) return false;
            return original.apply(this, args);
        };
    }
}

function unpatchSoundMethods() {
    const store = NotificationSettingsStore as any;

    for (const [methodName, original] of originalSoundMethods) {
        store[methodName] = original;
    }

    originalSoundMethods.clear();
}

function isInvisible(): boolean {
    const currentUser = UserStore.getCurrentUser();
    return !!currentUser && PresenceStore.getStatus(currentUser.id) === "invisible";
}

export default definePlugin({
    name: "InvisibleAsDnd",
    description: "Applique le comportement du mode Ne pas deranger aux notifications quand votre statut est invisible.",
    authors: [{ name: "Ba$h", id: 1462173272962764850n }],
    isModified: true,
    start() {
        if (originalGetUserAgnosticState == null) {
            originalGetUserAgnosticState = NotificationSettingsStore.getUserAgnosticState.bind(NotificationSettingsStore);
            NotificationSettingsStore.getUserAgnosticState = () => {
                const state = originalGetUserAgnosticState!();
                if (!isInvisible()) return state;
                return {
                    ...state,
                    taskbarFlash: false,
                    sound: false,
                    callSound: false,
                    disableAllSounds: true,
                };
            };
        }

        patchSoundMethods();

        if (originalTaskbarFlashDescriptor == null) {
            originalTaskbarFlashDescriptor = Object.getOwnPropertyDescriptor(NotificationSettingsStore, "taskbarFlash") ?? null;
            Object.defineProperty(NotificationSettingsStore, "taskbarFlash", {
                configurable: true,
                get() {
                    if (isInvisible()) return false;
                    return originalTaskbarFlashDescriptor?.get
                        ? originalTaskbarFlashDescriptor.get.call(NotificationSettingsStore)
                        : originalGetUserAgnosticState?.().taskbarFlash;
                }
            });
        }
    },
    stop() {
        if (originalGetUserAgnosticState) {
            NotificationSettingsStore.getUserAgnosticState = originalGetUserAgnosticState;
            originalGetUserAgnosticState = null;
        }

        unpatchSoundMethods();

        if (originalTaskbarFlashDescriptor) {
            Object.defineProperty(NotificationSettingsStore, "taskbarFlash", originalTaskbarFlashDescriptor);
            originalTaskbarFlashDescriptor = null;
        } else {
            delete (NotificationSettingsStore as any).taskbarFlash;
        }
    },
    patches: [
        {
            find: ".getDesktopType()===",
            replacement: [
                {
                    match: /(\i\.\i\.getDesktopType\(\)===\i\.\i\.NEVER)\)(?=.*?(\i\.\i\.playNotificationSound\(.{0,5}\)))/,
                    replace: "$&if($self.shouldSuppressNotification(arguments[0]?.message))return;else "
                },
                {
                    match: /sound:(\i\?(\i):void 0,volume:\i,onClick)/,
                    replace: "sound:$self.shouldSuppressNotification(arguments[0]?.message)?undefined:$1"
                }
            ]
        }
    ],
    shouldSuppressNotification(message?: MessageJSON) {
        const currentUser = UserStore.getCurrentUser();
        if (!currentUser || !isInvisible()) return false;
        return message?.author?.id !== currentUser.id;
    }
});
