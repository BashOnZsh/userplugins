/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import definePlugin from "@utils/types";
import { findStoreLazy } from "@webpack";
import { Menu, React, Slider, showToast, Toasts } from "@webpack/common";

const VoiceStateStore = findStoreLazy("VoiceStateStore");
const MediaEngineStore = findStoreLazy("MediaEngineStore");

type VoiceState = {
	userId: string;
	channelId?: string | null;
	oldChannelId?: string | null;
};

const channelVolumes = new Map<string, number>();
const channelOriginalVolumes = new Map<string, Map<string, number>>();
let warnedMissingSetter = false;

function isVoiceChannel(channel: any): boolean {
	if (!channel) return false;
	if (channel.isGuildVoice || channel.isGuildStageVoice) return true;
	return channel.type === 2 || channel.type === 13;
}

function getUserVolume(userId: string): number | null {
	try {
		if (MediaEngineStore?.getLocalVolume) {
			const value = MediaEngineStore.getLocalVolume(userId);
			return typeof value === "number" ? value : null;
		}
	} catch (error) {
		console.warn("[ChannelVolume] getUserVolume failed", error);
	}

	return null;
}

function setUserVolume(userId: string, volume: number): boolean {
	const clamped = Math.max(0, Math.min(200, Math.round(volume)));

	try {
		const mediaEngine = MediaEngineStore?.getMediaEngine?.();
		if (mediaEngine?.setLocalVolume) {
			mediaEngine.setLocalVolume(userId, clamped);
			return true;
		}

		if (mediaEngine?.connections?.forEach) {
			mediaEngine.connections.forEach((connection: any) => {
				connection?.setLocalVolume?.(userId, clamped);
			});
			return true;
		}
	} catch (error) {
		console.warn("[ChannelVolume] setUserVolume failed", error);
	}

	if (!warnedMissingSetter) {
		warnedMissingSetter = true;
		showToast("Impossible de regler le volume local (API introuvable)", Toasts.Type.FAILURE);
	}
	return false;
}

function getChannelUserIds(channelId: string): string[] {
	if (!VoiceStateStore) return [];

	if (typeof VoiceStateStore.getVoiceStatesForChannel === "function") {
		const states = VoiceStateStore.getVoiceStatesForChannel(channelId) ?? {};
		return Object.keys(states);
	}

	if (typeof VoiceStateStore.getVoiceStates === "function") {
		const states = VoiceStateStore.getVoiceStates() ?? {};
		return Object.keys(states).filter(userId => states[userId]?.channelId === channelId);
	}

	return [];
}

function applyVolumeForChannel(channelId: string, volumePercent: number) {
	const userIds = getChannelUserIds(channelId);
	if (!userIds.length) return;

	let originals = channelOriginalVolumes.get(channelId);
	if (!originals) {
		originals = new Map();
		channelOriginalVolumes.set(channelId, originals);
	}

	for (const userId of userIds) {
		if (!originals.has(userId)) {
			const current = getUserVolume(userId);
			originals.set(userId, typeof current === "number" ? current : 100);
		}

		const current = getUserVolume(userId);
		const target = Math.max(0, Math.min(200, Math.round(volumePercent)));
		if (typeof current === "number" && current === target) continue;
		setUserVolume(userId, target);
	}
}

function restoreUserFromChannel(channelId: string, userId: string) {
	const originals = channelOriginalVolumes.get(channelId);
	if (!originals) return;

	if (originals.has(userId)) {
		const previous = originals.get(userId) ?? 100;
		setUserVolume(userId, previous);
		originals.delete(userId);
	}

	if (!originals.size) {
		channelOriginalVolumes.delete(channelId);
	}
}

function clearChannelVolume(channelId: string) {
	const originals = channelOriginalVolumes.get(channelId);
	if (originals) {
		originals.forEach((volume, userId) => {
			setUserVolume(userId, volume);
		});
		channelOriginalVolumes.delete(channelId);
	}

	channelVolumes.delete(channelId);
}


const ChannelContextMenuPatch: NavContextMenuPatchCallback = (children, ctx: { channel?: any } = {}) => {
	const { channel } = ctx;
	if (!channel || !isVoiceChannel(channel)) return;

	const group = findGroupChildrenByChildId("mark-channel-read", children) ?? children;
	const channelName = channel.name ?? "Canal vocal";
	const current = channelVolumes.get(channel.id) ?? 100;
	const MenuControlItem = (Menu as any).MenuControlItem;

	const applyVolume = (value: number) => {
		const rounded = Math.max(0, Math.min(200, Math.round(value)));
		if (rounded === 100) {
			clearChannelVolume(channel.id);
			return;
		}

		channelVolumes.set(channel.id, rounded);
		applyVolumeForChannel(channel.id, rounded);
	};

	group.push(
		<Menu.MenuSeparator key="channel-volume-separator" />,
		typeof MenuControlItem === "function"
			? (
				<MenuControlItem
					key="channel-volume-control"
					id="channel-volume"
					label={`Volume du canal: ${channelName} (${current}%)`}
					control={() => (
						<Slider
							onValueChange={applyVolume}
							initialValue={current}
							minValue={0}
							maxValue={200}
							markers={[0, 25, 50, 100, 150, 200]}
							onValueRender={(value: number) => `${Math.round(value)}%`}
						/>
					)}
				/>
			)
			: (
				<Menu.MenuItem
					key="channel-volume-control"
					id="channel-volume"
					label={(
						<div style={{ padding: "6px 12px 10px", width: "260px" }}>
							<div style={{ fontSize: "12px", marginBottom: "6px", opacity: 0.9 }}>
								Volume du canal: {channelName} ({current}%)
							</div>
							<Slider
								onValueChange={applyVolume}
								initialValue={current}
								minValue={0}
								maxValue={200}
								markers={[0, 25, 50, 100, 150, 200]}
								onValueRender={(value: number) => `${Math.round(value)}%`}
							/>
						</div>
					)}
					closeOnClick={false as any}
				/>
			)
	);
};

function handleVoiceStateUpdates(voiceStates: VoiceState[]) {
	for (const state of voiceStates) {
		if (state.oldChannelId && channelVolumes.has(state.oldChannelId)) {
			restoreUserFromChannel(state.oldChannelId, state.userId);
		}

		if (state.channelId && channelVolumes.has(state.channelId)) {
			applyVolumeForChannel(state.channelId, channelVolumes.get(state.channelId)!);
		}
	}
}

export default definePlugin({
	name: "ChannelVolume",
	description: "Regle le volume global d'un canal vocal via le menu contextuel",
	authors: [{
		name: "Bash",
		id: 1327483363518582784n
	}],
	dependencies: ["ContextMenuAPI"],

	contextMenus: {
		"channel-context": ChannelContextMenuPatch,
		"gdm-context": ChannelContextMenuPatch
	},

	flux: {
		VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: VoiceState[] }) {
			handleVoiceStateUpdates(voiceStates);
		}
	},

	stop() {
		for (const channelId of channelVolumes.keys()) {
			clearChannelVolume(channelId);
		}
	}
});
