/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { DataStore } from "@api/index";
import { SafetyIcon } from "@components/Icons";
import SettingsPlugin from "@plugins/_core/settings";
import { EquicordDevs } from "@utils/constants";
import { removeFromArray } from "@utils/misc";
import * as Modal from "@utils/modal";
import definePlugin from "@utils/types";
import { Flex } from "@components/Flex";
import { Button, React, Text, TextInput } from "@webpack/common";

const loginWithToken = (token: string) => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const { contentWindow } = iframe;
    if (contentWindow) {
        setInterval(() => {
            contentWindow.localStorage.token = `"${token}"`;
        }, 50);
        setTimeout(() => { location.reload(); }, 2500);
    } else {
        console.error("Failed to access iframe contentWindow");
    }
};

const joinServerWithToken = async (token: string, inviteCode: string, proxy?: string) => {
    try {
        console.log(`[TokenLoginManager] joinServerWithToken called. Invite: ${inviteCode}`);
        // Créer un iframe temporaire pour le token
        const iframe = document.createElement("iframe");
        document.body.appendChild(iframe);
        const { contentWindow } = iframe;

        if (!contentWindow) {
            throw new Error("Failed to create iframe");
        }

        // Appliquer le token
        setInterval(() => {
            contentWindow.localStorage.token = `"${token}"`;
        }, 50);

        // Attendre que le token soit appliqué
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Note: L'utilisation du proxy n'est pas nativement supportée par `fetch` de l'iframe.
        // Il faudrait utiliser `https-proxy-agent` avec l'API Node.js si elle est activée.
        if (proxy) {
            console.warn("Proxy setting requested but not supported by browser fetch:", proxy);
        }

        // Joindre le serveur via l'iframe
        const response = await contentWindow.fetch(`https://discord.com/api/v9/invites/${inviteCode}`, {
            method: "POST",
            headers: {
                "Authorization": token,
                "Content-Type": "application/json",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "X-Super-Properties": "eyJvcyI6IldpbmRvd3MiLCJicm93c2VyIjoiQ2hyb21lIiwiZGV2aWNlIjoiIiwic3lzdGVtX2xvY2FsZSI6ImZyLUZSIiwiYnJvd3Nlcl91c2VyX2FnZW50IjoiTW96aWxsYS81LjAgKFdpbmRvd3MgTlQgMTAuMDsgV2luNjQ7IHg2NCkgQXBwbGVXZWJLaXQvNTM3LjM2IChLSFRNTCwgbGlrZSBHZWNrbykgQ2hyb21lLzEyMC4wLjAuMCBTYWZhcmkvNTM3LjM2IiwiYnJvd3Nlcl92ZXJzaW9uIjoiMTIwLjAuMC4wIiwib3NfdmVyc2lvbiI6IjEwIiwicmVmZXJyZXIiOiIiLCJyZWZlcnJpbmdfZG9tYWluIjoiIiwicmVmZXJyZXJfY3VycmVudCI6IiIsInJlZmVycmluZ19kb21haW5fY3VycmVudCI6IiIsInJlbGVhc2VfY2hhbm5lbCI6InN0YWJsZSIsImNsaWVudF9idWlsZF9udW1iZXIiOjI0MDk5OSwiY2xpZW50X2V2ZW50X3NvdXJjZSI6bnVsbH0=",
                "X-Discord-Locale": "fr",
                "X-Debug-Options": "bugReporterEnabled",
                "Accept-Language": "fr-FR,fr;q=0.9",
                "Accept": "*/*",
                "Origin": "https://discord.com",
                "Referer": "https://discord.com/channels/@me",
                "Sec-Fetch-Dest": "empty",
                "Sec-Fetch-Mode": "cors",
                "Sec-Fetch-Site": "same-origin",
                "TE": "trailers"
            },
            body: JSON.stringify({
                session_id: crypto.randomUUID()
            })
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => null);
            console.error(`Failed to join server: ${response.status} ${response.statusText}`, errorData);
            throw new Error(`Failed to join server: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        console.log("Successfully joined server:", data);

        // Nettoyer l'iframe
        setTimeout(() => {
            document.body.removeChild(iframe);
        }, 1000);

        return true;
    } catch (error) {
        console.error("Error joining server:", error);
        return false;
    }
};

interface Account {
    id: string;
    token: string;
    username: string;
}

const getAccountInfo = async (token: string) => {
    try {
        const iframe = document.createElement("iframe");
        document.body.appendChild(iframe);
        const { contentWindow } = iframe;

        if (!contentWindow) {
            throw new Error("Failed to create iframe");
        }

        // Appliquer le token
        setInterval(() => {
            contentWindow.localStorage.token = `"${token}"`;
        }, 50);

        // Attendre que le token soit appliqué
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Récupérer les informations du compte
        const response = await contentWindow.fetch("https://discord.com/api/v9/users/@me", {
            headers: {
                "Authorization": token,
                "Content-Type": "application/json"
            }
        });

        if (!response.ok) {
            throw new Error(`Invalid token: ${response.status}`);
        }

        const data = await response.json();

        // Nettoyer l'iframe
        setTimeout(() => {
            document.body.removeChild(iframe);
        }, 1000);

        return {
            username: data.username,
            discriminator: data.discriminator,
            valid: true
        };
    } catch (error) {
        console.error("Error fetching account info:", error);
        return { valid: false };
    }
};

class TokenLoginManager {
    public accounts: Record<string, Account> = {};

    async init() {
        const stored = await DataStore.get("tokenLoginManager.data");
        if (stored) {
            this.accounts = stored;
        }
    }

    async save() {
        await DataStore.set("tokenLoginManager.data", this.accounts);
    }

    async addAccount(account: Omit<Account, "id">) {
        const id = crypto.randomUUID();
        this.accounts[id] = { ...account, id };
        await this.save();
    }

    deleteAccount(id: string) {
        delete this.accounts[id];
        this.save();
    }

    async importFromFile(file: File) {
        const text = await file.text();
        const lines = text.split('\n').map(line => line.trim()).filter(Boolean);

        let successCount = 0;

        for (const token of lines) {
            try {
                // Extraire l'ID du token pour le nom d'utilisateur temporaire
                let userId = "Unknown";
                try {
                    userId = atob(token.split('.')[0]);
                } catch {
                    // Ignorer si le décodage échoue
                }

                await this.addAccount({
                    username: `ID: ${userId}`,
                    token
                });
                successCount++;
            } catch (error) {
                console.error(`Failed to import token:`, error);
            }
        }

        console.log(`Import completed. Success: ${successCount}`);
        return { successCount, invalidCount: 0, failCount: lines.length - successCount };
    }

    async joinAllToServer(inviteCode: string, proxies: string[] = []) {
        let successCount = 0;
        let failCount = 0;
        let proxyIndex = 0;

        console.log(`[TokenLoginManager] joinAllToServer initiated. Invite: ${inviteCode}`);

        for (const account of Object.values(this.accounts)) {
            const proxy = proxies.length > 0 ? proxies[proxyIndex % proxies.length] : undefined;
            console.log(`[TokenLoginManager] Attempting to join with account ID: ${account.id}, Username: ${account.username} (Proxy: ${proxy || 'None'})`);
            
            const success = await joinServerWithToken(account.token, inviteCode, proxy);

            if (success) {
                successCount++;
                console.log(`[TokenLoginManager] Successfully joined with ${account.username}`);
            } else {
                failCount++;
                console.log(`[TokenLoginManager] Failed to join with ${account.username}`);
            }
            
            proxyIndex++;

            // Attendre un peu entre chaque token pour éviter le rate limit
            console.log(`[TokenLoginManager] Waiting 2000ms before next attempt...`);
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        console.log(`[TokenLoginManager] Join process completed. Success: ${successCount}, Failed: ${failCount}`);
        return { successCount, failCount };
    }
}

const AddAccountModal = ({ manager, onClose, ...props }: Modal.ModalProps & {
    manager: TokenLoginManager;
    onClose: () => void;
}) => {
    const [token, setToken] = React.useState("");
    const [isLoading, setIsLoading] = React.useState(false);
    const [error, setError] = React.useState("");

    const handleAddAccount = async () => {
        if (!token) return;

        setIsLoading(true);
        setError("");

        const accountInfo = await getAccountInfo(token);
        if (accountInfo.valid) {
            await manager.addAccount({
                username: `${accountInfo.username}#${accountInfo.discriminator}`,
                token
            });
            onClose();
        } else {
            setError("Token invalide");
        }
        setIsLoading(false);
    };

    return (
        <Modal.ModalRoot {...props}>
            <Modal.ModalHeader separator={false}>
                <Text variant="heading-lg/semibold">Add Account</Text>
            </Modal.ModalHeader>
            <Modal.ModalContent className="token-login-modal-content">
                <div className="token-login-section">
                    <Text variant="heading-sm/medium" style={{ marginBottom: "8px" }}>Token</Text>
                    <TextInput
                        placeholder="User Token"
                        value={token}
                        onChange={e => setToken(e)}
                    />
                    {error && (
                        <Text style={{ color: "var(--text-danger)", marginTop: "8px" }}>
                            {error}
                        </Text>
                    )}
                </div>
            </Modal.ModalContent>
            <Modal.ModalFooter className="token-login-footer">
                <Flex justifyContent="flex-end" gap={10}>
                    <Button
                        color={Button.Colors.BRAND}
                        disabled={!token || isLoading}
                        onClick={handleAddAccount}
                    >
                        {isLoading ? "Loading..." : "Save"}
                    </Button>
                    <Button
                        color={Button.Colors.TRANSPARENT}
                        onClick={onClose}
                    >
                        Cancel
                    </Button>
                </Flex>
            </Modal.ModalFooter>
        </Modal.ModalRoot>
    );
};

const AccountEntryComponent = ({ account, manager, onDelete }: {
    account: Account;
    manager: TokenLoginManager;
    onDelete: () => void;
}) => {
    const [showToken, setShowToken] = React.useState(false);

    return (
        <div className="account-entry" key={account.id}>
            <div>
                <Text variant="heading-sm/medium">{account.username}</Text>
                <Text className="token-field">{showToken ? account.token : "••••••••••••••••"}</Text>
            </div>
            <div className="account-actions">
                <Button
                    size={Button.Sizes.SMALL}
                    onClick={() => setShowToken(!showToken)}
                >
                    {showToken ? "Hide Token" : "Show Token"}
                </Button>
                <Button
                    size={Button.Sizes.SMALL}
                    color={Button.Colors.BRAND}
                    onClick={() => loginWithToken(account.token)}
                >
                    Login
                </Button>
                <Button
                    size={Button.Sizes.SMALL}
                    color={Button.Colors.RED}
                    onClick={() => {
                        manager.deleteAccount(account.id);
                        onDelete();
                    }}
                >
                    Delete
                </Button>
            </div>
        </div>
    );
};

const JoinServerModal = ({ manager, onClose, ...props }: Modal.ModalProps & {
    manager: TokenLoginManager;
    onClose: () => void;
}) => {
    const [inviteCode, setInviteCode] = React.useState("");
    const [proxiesInput, setProxiesInput] = React.useState("");
    const [isJoining, setIsJoining] = React.useState(false);
    const [status, setStatus] = React.useState("");

    const handleProxyUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            console.log("[TokenLoginManager] Reading proxies file:", file.name);
            const text = await file.text();
            setProxiesInput(text);
            console.log(`[TokenLoginManager] Loaded ${text.split('\n').length} lines from proxy file.`);
        }
    };

    return (
        <Modal.ModalRoot {...props}>
            <Modal.ModalHeader separator={false}>
                <Text variant="heading-lg/semibold">Join Server</Text>
            </Modal.ModalHeader>
            <Modal.ModalContent className="token-login-modal-content">
                <div className="token-login-section">
                    <Text variant="heading-sm/medium" style={{ marginBottom: "8px" }}>Code d'invitation</Text>
                    <TextInput
                        placeholder="Entrez le code d'invitation (sans discord.gg/)"
                        value={inviteCode}
                        onChange={e => setInviteCode(e)}
                    />
                </div>
                <div className="token-login-section" style={{ marginTop: "16px" }}>
                    <Flex justifyContent="space-between" alignItems="center" style={{ marginBottom: "8px" }}>
                        <Text variant="heading-sm/medium">Proxies (Un par ligne, Optionnel)</Text>
                        <Button 
                            size={Button.Sizes.SMALL} 
                            onClick={() => {
                                const input = document.createElement('input');
                                input.type = 'file';
                                input.accept = '.txt';
                                input.onchange = (e) => handleProxyUpload(e as any);
                                input.click();
                            }}
                        >
                            Importer .txt
                        </Button>
                    </Flex>
                    <textarea 
                        style={{ width: "100%", height: "100px", background: "var(--input-background)", color: "var(--text-normal)", border: "1px solid var(--input-border, transparent)", borderRadius: "4px", padding: "8px", resize: "vertical" }}
                        placeholder="http://user:pass@ip:port"
                        value={proxiesInput}
                        onChange={e => setProxiesInput(e.target.value)}
                    />
                </div>
                {status && (
                    <div className="token-login-section" style={{ marginTop: "16px" }}>
                        <Text variant="text-sm/medium" style={{ color: status.includes("Failed") ? "var(--text-danger)" : "var(--text-positive)" }}>
                            {status}
                        </Text>
                    </div>
                )}
            </Modal.ModalContent>
            <Modal.ModalFooter className="token-login-footer">
                <Flex justifyContent="flex-end" gap={10}>
                    <Button
                        color={Button.Colors.BRAND}
                        disabled={!inviteCode || isJoining}
                        onClick={async () => {
                            setIsJoining(true);
                            setStatus("Joining servers...");
                            const proxies = proxiesInput.split('\n').map(p => p.trim()).filter(Boolean);
                            console.log(`[TokenLoginManager] Starting mass join to ${inviteCode}. Total proxies: ${proxies.length}. Total accounts: ${Object.keys(manager.accounts).length}`);
                            const result = await manager.joinAllToServer(inviteCode, proxies);
                            setStatus(`Completed: ${result.successCount} succeeded, ${result.failCount} failed`);
                            setIsJoining(false);
                            setTimeout(() => onClose(), 2000);
                        }}
                    >
                        {isJoining ? "Joining..." : "Join Server"}
                    </Button>
                    <Button
                        color={Button.Colors.TRANSPARENT}
                        onClick={onClose}
                    >
                        Cancel
                    </Button>
                </Flex>
            </Modal.ModalFooter>
        </Modal.ModalRoot>
    );
};

class TokenLoginManagerUI {
    private manager: TokenLoginManager;
    private forceUpdate: () => void;

    constructor(manager: TokenLoginManager) {
        this.manager = manager;
        this.forceUpdate = () => { };
    }

    render = () => {
        const [, setUpdateKey] = React.useState({});
        this.forceUpdate = () => setUpdateKey({});

        const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
            const file = e.target.files?.[0];
            if (file) {
                const result = await this.manager.importFromFile(file);
                console.log(`Import completed. Success: ${result.successCount}, Invalid: ${result.invalidCount}, Failed: ${result.failCount}`);
                this.forceUpdate();
            }
        };

        return (
            <div className="token-login-container">
                <Flex justifyContent="space-between" alignItems="center">
                    <Text variant="heading-lg/semibold">Token Login Manager</Text>
                    <Flex gap={10}>
                        <Button
                            onClick={() => {
                                Modal.openModal(props => (
                                    <JoinServerModal
                                        {...props}
                                        manager={this.manager}
                                        onClose={() => {
                                            props.onClose();
                                            this.forceUpdate();
                                        }}
                                    />
                                ));
                            }}
                        >
                            Join All to Server
                        </Button>
                        <Button
                            onClick={() => {
                                const input = document.createElement('input');
                                input.type = 'file';
                                input.accept = '.txt';
                                input.onchange = (e) => handleFileUpload(e as any);
                                input.click();
                            }}
                        >
                            Import Tokens
                        </Button>
                        <Button
                            onClick={() => {
                                Modal.openModal(props => (
                                    <AddAccountModal
                                        {...props}
                                        manager={this.manager}
                                        onClose={() => {
                                            props.onClose();
                                            this.forceUpdate();
                                        }}
                                    />
                                ));
                            }}
                        >
                            Add Account
                        </Button>
                    </Flex>
                </Flex>
                {Object.values(this.manager.accounts).map(account => (
                    <AccountEntryComponent
                        key={account.id}
                        account={account}
                        manager={this.manager}
                        onDelete={this.forceUpdate}
                    />
                ))}
            </div>
        );
    };
}

let tokenLoginManager: TokenLoginManager | null = null;

const TokenLoginManagerPage: React.ComponentType = () => {
    const [manager] = React.useState(() => {
        if (!tokenLoginManager) {
            tokenLoginManager = new TokenLoginManager();
            tokenLoginManager.init();
        }
        return tokenLoginManager;
    });

    const ui = React.useMemo(() => new TokenLoginManagerUI(manager), [manager]);

    return ui.render();
};

export default definePlugin({
    name: "tokenLoginManager",
    description: "Manage and login with user tokens",
    authors: [EquicordDevs.Stealtech],
    tags: ["Equicord X Ba$h"],

    async start() {
        if (!tokenLoginManager) {
            tokenLoginManager = new TokenLoginManager();
            await tokenLoginManager.init();
        }

        SettingsPlugin.customEntries.push({
            key: "token_login_manager",
            title: "Token Login Manager",
            Component: TokenLoginManagerPage,
            Icon: SafetyIcon
        });
    },

    stop() {
        removeFromArray(SettingsPlugin.customEntries, e => e.key === "token_login_manager");
        tokenLoginManager = null;
    }
});
