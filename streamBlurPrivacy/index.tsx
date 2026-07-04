/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import * as DataStore from "@api/DataStore";
import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import { getCurrentChannel } from "@utils/discord";
import definePlugin, { OptionType } from "@utils/types";
import { findByPropsLazy } from "@webpack";
import { FluxDispatcher, Menu, UserStore } from "@webpack/common";
import { Channel } from "discord-types/general";

// Modules Discord pour détecter quand l'utilisateur stream
const StreamStore = findByPropsLazy("getActiveStreamForUser", "getAllActiveStreams");
const RTCConnectionStore = findByPropsLazy("getMediaSessionId");

// Configuration du plugin
const DATASTORE_KEY = "StreamBlurPrivacy_BlurredChannels";
const PLUGIN_NAME = "StreamBlurPrivacy";
const BLUR_INTENSITY = "10px";
const BLUR_CSS_ID = "streamblur-privacy-css";

// État global du plugin (conversations floutées, état du stream, etc.)
let blurredChannels: Set<string> = new Set();
let styleElement: HTMLStyleElement | null = null;
let activeChannelId: string | null = null;
let isCurrentlyStreaming = false;
let fluxUnsubscribers: Array<() => void> = [];
let checkInterval: NodeJS.Timeout | null = null;

const settings = definePluginSettings({
	blurIntensity: {
		type: OptionType.NUMBER,
		description: "Intensity of the blur effect (in pixels)",
		default: 10,
		min: 1,
		max: 30
	},
	autoBlurOnStream: {
		type: OptionType.BOOLEAN,
		description: "Automatically apply blur when streaming if conversation is marked",
		default: true
	},
	showNotifications: {
		type: OptionType.BOOLEAN,
		description: "Show notifications when toggling blur status",
		default: true
	},
	debugMode: {
		type: OptionType.BOOLEAN,
		description: "Enable debug logs in console",
		default: false
	}
});

// Fonction pour afficher les messages dans la console avec timestamp et style
function log(message: string, level: "info" | "warn" | "error" = "info") {
	const timestamp = new Date().toLocaleTimeString();
	const prefix = `[${PLUGIN_NAME} ${timestamp}]`;

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

function debugLog(message: string) {
	if (settings.store.debugMode) {
		log(`DEBUG: ${message}`, "info");
	}
}

// Inspecte la structure du DOM pour identifier les sélecteurs CSS corrects des messages
function inspectMessageDOM(): void {
	try {
		console.log("[StreamBlurPrivacy] ===== DOM INSPECTION START =====");

		// On teste plusieurs sélecteurs CSS pour trouver les messages et diagnostiquer les problèmes
		const selectors = [
			"[class*='containerCozy']",
			"[class*='containerCompact']",
			"[class*='messageListing'] > div",
			"[role='article']",
			"div[class*='message_']",
			"li[class*='message']",
			"[data-list-item-id]"
		];

		for (const selector of selectors) {
			const elements = document.querySelectorAll(selector);
			if (elements.length > 0) {
				console.log(`[StreamBlurPrivacy] Selector "${selector}" found ${elements.length} elements`);
				const el = elements[0] as HTMLElement;
				console.log("  - First element classes:", el.className);
				console.log("  - First element HTML preview:", el.innerHTML?.substring(0, 150));
			}
		}

		// Vérifie si le CSS de floutage a bien été injecté dans la page
		const styleEl = document.getElementById(BLUR_CSS_ID);
		if (styleEl && styleEl.textContent) {
			console.log(`[StreamBlurPrivacy] Blur CSS is present (${styleEl.textContent.length} chars)`);
			console.log("[StreamBlurPrivacy] CSS rules:");
			styleEl.textContent.split("\n").forEach((line, idx) => {
				if (line.trim() && !line.trim().startsWith("/*")) {
					console.log(`  ${idx}: ${line.substring(0, 80)}`);
				}
			});
		} else {
			console.warn("[StreamBlurPrivacy] Blur CSS not found or empty!");
		}

		// Vérifie que les styles CSS s'appliquent correctement sur un message
		const testEl = document.querySelector("[class*='containerCozy']") as HTMLElement;
		if (testEl) {
			const computed = window.getComputedStyle(testEl);
			console.log("[StreamBlurPrivacy] Sample element computed filter:", computed.filter);
		}

		console.log("[StreamBlurPrivacy] ===== DOM INSPECTION END =====");
	} catch (error) {
		console.error("[StreamBlurPrivacy] Error inspecting DOM:", error);
	}
}

// Récupère depuis la sauvegarde la liste des conversations à flouter
async function loadBlurredChannels(): Promise<void> {
	try {
		const stored = await DataStore.get(DATASTORE_KEY);
		if (stored && Array.isArray(stored)) {
			blurredChannels = new Set(stored);
			debugLog(`Loaded ${blurredChannels.size} blurred channels from storage`);
		}
	} catch (error) {
		log(`Error loading blurred channels: ${error}`, "error");
	}
}

// Sauvegarde la liste des conversations floutées pour qu'elle persiste après redémarrage
async function saveBlurredChannels(): Promise<void> {
	try {
		await DataStore.set(DATASTORE_KEY, Array.from(blurredChannels));
		debugLog(`Saved ${blurredChannels.size} blurred channels to storage`);
	} catch (error) {
		log(`Error saving blurred channels: ${error}`, "error");
	}
}

// Détecte si l'utilisateur est actuellement en train de streamer (utilise 3 méthodes de secours)
function isStreaming(): boolean {
	try {
		const currentUser = UserStore?.getCurrentUser?.();
		if (!currentUser) {
			debugLog("No current user found for stream detection");
			return false;
		}

		// Méthode 1 : Vérifier via StreamStore (la plus fiable)
		const userStream = StreamStore?.getActiveStreamForUser?.(currentUser.id);
		if (userStream) {
			debugLog("Stream detected via getActiveStreamForUser");
			return true;
		}

		// Méthode 2 : Vérifier si l'utilisateur a un stream actif dans la liste globale
		const allStreams = StreamStore?.getAllActiveStreams?.();
		if (allStreams && allStreams.length > 0) {
			const myStream = allStreams.find((s: any) => s.ownerId === currentUser.id);
			if (myStream) {
				debugLog("Stream detected via getAllActiveStreams");
				return true;
			}
		}

		// Méthode 3 : Vérifier via la connexion RTC (fallback au cas où les autres méthodes échouent)
		const mediaSessionId = RTCConnectionStore?.getMediaSessionId?.();
		if (mediaSessionId) {
			const state = RTCConnectionStore?.getState?.();
			if (state && state.context === "stream") {
				debugLog("Stream detected via RTCConnectionStore");
				return true;
			}
		}

		debugLog("No stream detected");
		return false;
	} catch (e) {
		log(`Error checking stream status: ${e}`, "error");
		return false;
	}
}

// Injecte le CSS qui floute les messages dans le DOM du navigateur
function injectBlurCSS(channelId: string, intensity: number = settings.store.blurIntensity): void {
	debugLog(`Injecting blur CSS for channel: ${channelId}`);

	if (!styleElement) {
		styleElement = document.createElement("style");
		styleElement.id = BLUR_CSS_ID;
		document.head.appendChild(styleElement);
	}

	const blurValue = `${intensity}px`;
	// On cible UNIQUEMENT les messages pour éviter de flouter toute l'interface Discord en dehors du chat
	const css = `
		/* Stream Blur Privacy - Conversation active ${channelId} */

		/* Floute UNIQUEMENT à l'intérieur de la zone de chat (contexte du message listing) */
		ol[data-list-id="chat-messages"] li[id*="chat-messages"],
		ol[data-list-id="chat-messages"] div[role="article"] {
			filter: blur(${blurValue}) !important;
		}

		/* Les conteneurs de contenu des messages - utilisés par ID pour éviter les conflits */
		div[id*="message-content"],
		div[id*="message-accessories"],
		div[id*="message-username"],
		div[id*="message-header"],
		div[id*="message-reply"] {
			filter: blur(${blurValue}) !important;
		}

		/* Texte des messages - UNIQUEMENT à l'intérieur des messages */
		div[id*="message-content"] span,
		div[id*="message-content"] div,
		div[id*="message-username"] span,
		span[class*="username_"][style*="color"],
		span[id*="message-username"] {
			filter: blur(${blurValue}) !important;
		}

		/* Avatars et timestamps dans les en-têtes de messages */
		div[id*="message-content"] img,
		img[class*="avatar_"],
		div[id*="message-timestamp"],
		time {
			filter: blur(${blurValue}) !important;
		}

		/* Les vidéos et intégrations (embeds) - UNIQUEMENT dans les messages */
		div[id*="message-accessories"] > div,
		div[id*="message-accessories"] img,
		div[id*="message-accessories"] video {
			filter: blur(${blurValue}) !important;
		}
	`;

	if (!styleElement.textContent) {
		styleElement.textContent = css;
	} else {
		styleElement.textContent += "\n" + css;
	}

	log(`Blur CSS injected for channel ${channelId} with intensity ${blurValue}`);

	if (settings.store.debugMode) {
		console.log("[StreamBlurPrivacy] Full CSS injected:\n", styleElement.textContent);
		// Petit délai pour s'assurer que le CSS est appliqué avant l'inspection du DOM
		setTimeout(() => inspectMessageDOM(), 100);
	}
}

// Enlève le CSS de floutage du DOM
function removeBlurCSS(channelId?: string): void {
	debugLog(`Removing blur CSS${channelId ? ` for channel: ${channelId}` : ""}`);

	if (styleElement) {
		styleElement.textContent = "";
		log("Blur CSS cleared");
	}
}

// Met à jour l'état du floutage en fonction des conditions actuelles (stream actif, config, etc.)
function updateBlurState(): void {
	debugLog(`Updating blur state: Stream=${isCurrentlyStreaming}, ActiveChannel=${activeChannelId}`);

	if (!activeChannelId) {
		debugLog("No active channel, removing all blur");
		if (styleElement && styleElement.textContent) {
			styleElement.textContent = "";
		}
		return;
	}

	const shouldBlur = isCurrentlyStreaming && blurredChannels.has(activeChannelId) && settings.store.autoBlurOnStream;
	const isBlurApplied = styleElement && styleElement.textContent && styleElement.textContent.trim().length > 0;

	debugLog(`Should apply blur: ${shouldBlur}, Currently applied: ${isBlurApplied}, Channel in set: ${blurredChannels.has(activeChannelId)}`);

	if (shouldBlur && !isBlurApplied) {
		log(`Applying blur for channel ${activeChannelId}`);
		injectBlurCSS(activeChannelId);
	} else if (!shouldBlur && isBlurApplied) {
		log(`Removing blur for channel ${activeChannelId}`);
		removeBlurCSS(activeChannelId);
	}
}

// Change l'état du floutage pour une conversation (on/off) et sauvegarde
async function toggleChannelBlur(channelId: string, channelName: string): Promise<void> {
	try {
		const wasBlurred = blurredChannels.has(channelId);

		if (wasBlurred) {
			blurredChannels.delete(channelId);
			removeBlurCSS(channelId);
			log(`Blur disabled for channel: ${channelName} (${channelId})`);
		} else {
			blurredChannels.add(channelId);
			log(`Blur enabled for channel: ${channelName} (${channelId})`);
		}

		await saveBlurredChannels();

		if (settings.store.showNotifications) {
			showNotification({
				title: PLUGIN_NAME,
				body: `Blur ${wasBlurred ? "disabled" : "enabled"} for: ${channelName}`,
				icon: undefined
			});
		}

		// Met à jour l'interface si c'est la conversation active
		if (activeChannelId === channelId) {
			updateBlurState();
		}
	} catch (error) {
		log(`Error toggling channel blur: ${error}`, "error");
	}
}

function getBlurTargetChannel(props: { channel?: Channel; user?: { id: string; username?: string; discriminator?: string; }; }): Channel | null {
	if (props.channel && (props.channel.type === 1 || props.channel.type === 3)) {
		return props.channel;
	}

	const currentChannel = getCurrentChannel?.();
	if (currentChannel && (currentChannel.type === 1 || currentChannel.type === 3)) {
		return currentChannel as Channel;
	}

	return null;
}

// Ajoute l'option "Stream blur: ON/OFF" aux menus des conversations privées et des utilisateurs liés à un DM
const GDMContextMenuPatch: NavContextMenuPatchCallback = (children: any, props: { channel?: Channel; user?: { id: string; username?: string; discriminator?: string; }; }) => {
	const channel = getBlurTargetChannel(props);

	if (!channel) {
		return;
	}

	try {
		const isBlurred = blurredChannels.has(channel.id);
		const channelName = channel.name || (channel.type === 1 ? "Direct Message" : "Group");

		const group = findGroupChildrenByChildId(["leave-channel", "close-dm"], children);

		if (group) {
			group.push(
				<Menu.MenuSeparator />,
				<Menu.MenuItem
					id="stream-blur-privacy-toggle"
					label={`Stream blur: ${isBlurred ? "ON" : "OFF"} - ${channelName}`}
					color={isBlurred ? "brand" : ""}
					action={() => toggleChannelBlur(channel.id, channelName)}
					icon={() => (
						<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
							<path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z" />
						</svg>
					)}
				/>
			);
		}
	} catch (error) {
		log(`Error in context menu patch: ${error}`, "error");
	}
};

// Définition et configuration du plugin
export default definePlugin({
	name: PLUGIN_NAME,
	description: "Blur messages in selected conversations when streaming for privacy",
	authors: [{
		name: "Bash",
		id: 1327483363518582784n
	}],
	dependencies: ["ContextMenuAPI"],
	settings,

	contextMenus: {
		"gdm-context": GDMContextMenuPatch,
		"user-context": GDMContextMenuPatch,
		"user-profile-actions": GDMContextMenuPatch,
		"user-profile-overflow-menu": GDMContextMenuPatch
	},

	async start() {
		log("Plugin starting...");

		// Charger les conversations floutées depuis la sauvegarde Vencord
		await loadBlurredChannels();

		// S'abonner aux événements Discord pour détecter les changements
		const handleStreamCreate = () => {
			debugLog("STREAM_CREATE event");
			isCurrentlyStreaming = true;
			updateBlurState();
		};

		const handleStreamStop = () => {
			debugLog("STREAM_STOP event");
			isCurrentlyStreaming = false;
			updateBlurState();
		};

		const handleChannelSelect = (data: any) => {
			const newChannelId = data?.channelId;
			if (newChannelId && newChannelId !== activeChannelId) {
				debugLog(`Channel changed: ${activeChannelId} -> ${newChannelId}`);
				activeChannelId = newChannelId;
				updateBlurState();
			}
		};

		fluxUnsubscribers.push(
			FluxDispatcher.subscribe("STREAM_CREATE", handleStreamCreate),
			FluxDispatcher.subscribe("STREAM_START", handleStreamCreate),
			FluxDispatcher.subscribe("STREAM_STOP", handleStreamStop),
			FluxDispatcher.subscribe("STREAM_DELETE", handleStreamStop),
			FluxDispatcher.subscribe("CHANNEL_SELECT", handleChannelSelect)
		);

		// Vérification périodique du statut du stream (pour détecter les changements manqués)
		checkInterval = setInterval(() => {
			const wasStreaming = isCurrentlyStreaming;
			isCurrentlyStreaming = isStreaming();

			if (wasStreaming !== isCurrentlyStreaming) {
				debugLog(`Stream status changed: ${wasStreaming} -> ${isCurrentlyStreaming}`);
				updateBlurState();
			}
		}, 2000);

		if (settings.store.showNotifications) {
			showNotification({
				title: PLUGIN_NAME,
				body: "Plugin started. Right-click a DM to toggle blur.",
				icon: undefined
			});
		}

		log("Plugin started successfully");

		// Rend les fonctions de débogage accessibles dans la console du navigateur
		(window as any).StreamBlurPrivacy = {
			injectTestBlur: (intensity: number = 5) => {
				const testStyle = document.createElement("style");
				testStyle.id = "streamblur-test-css";
				testStyle.textContent = `
					[class*="containerCozy"],
					[class*="containerCompact"],
					[role="article"] {
						filter: blur(${intensity}px) !important;
						outline: 2px solid red;
					}
				`;
				document.head.appendChild(testStyle);
				console.log(`[StreamBlurPrivacy] TEST: Injected blur(${intensity}px) on messages`);
			},
			removeTestBlur: () => {
				document.getElementById("streamblur-test-css")?.remove();
				console.log("[StreamBlurPrivacy] TEST: Removed test blur");
			},
			inspectDom: () => inspectMessageDOM(),
			getState: () => ({
				isStreaming: isCurrentlyStreaming,
				activeChannelId,
				blurredChannels: Array.from(blurredChannels),
				cssInjected: !!document.getElementById(BLUR_CSS_ID)?.textContent
			}),
			manuallyApplyBlur: () => injectBlurCSS(activeChannelId || "test", 10),
			manuallyRemoveBlur: () => removeBlurCSS()
		};

		console.log("[StreamBlurPrivacy] Commandes de débogage disponibles dans la console:");
		console.log("  window.StreamBlurPrivacy.injectTestBlur()");
		console.log("  window.StreamBlurPrivacy.removeTestBlur()");
		console.log("  window.StreamBlurPrivacy.inspectDom()");
		console.log("  window.StreamBlurPrivacy.getState()");
		console.log("  window.StreamBlurPrivacy.manuallyApplyBlur()");
		console.log("  window.StreamBlurPrivacy.manuallyRemoveBlur()");
	},

	stop() {
		log("Plugin stopping...");

		// Se désabonner de tous les événements Discord
		fluxUnsubscribers.forEach(unsubscriber => {
			if (typeof unsubscriber === "function") {
				unsubscriber();
			}
		});
		fluxUnsubscribers = [];

		// Arrêter la vérification périodique du statut du stream
		if (checkInterval) {
			clearInterval(checkInterval);
			checkInterval = null;
		}

		// Enlever tout le CSS injecté du DOM
		if (styleElement) {
			styleElement.remove();
			styleElement = null;
		}

		// Réinitialiser l'état du plugin
		isCurrentlyStreaming = false;
		activeChannelId = null;

		log("Plugin stopped");
	}
});
