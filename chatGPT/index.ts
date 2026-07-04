/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType, ApplicationCommandOptionType, sendBotMessage } from "@api/Commands";
import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";

const DISCORD_MESSAGE_LIMIT = 1900;
const DEFAULT_OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_TITLE = "Bashcord ChatGPT Plugin";
const FREE_FALLBACK_MODELS = [
    "google/gemini-2.0-flash-exp:free",
    "meta-llama/llama-3.3-70b-instruct:free",
    "qwen/qwen-2.5-vl-72b-instruct:free",
    "deepseek/deepseek-r1:free",
    "mistralai/mistral-small-3.1-24b-instruct:free"
] as const;

type ChatRole = "system" | "user" | "assistant";
type ChatMessage = {
    role: ChatRole;
    content: string;
};

const settings = definePluginSettings({
    apiKey: {
        type: OptionType.STRING,
        description: "Votre cle API OpenRouter (obtenue sur https://openrouter.ai/keys)",
        default: "",
        placeholder: "sk-or-v1-...",
        componentProps: {
            type: "password"
        }
    },
    model: {
        type: OptionType.SELECT,
        description: "Modele OpenRouter a utiliser",
        default: "google/gemini-2.0-flash-exp:free",
        options: [
            { label: "Gemini 2.0 Flash - Free", value: "google/gemini-2.0-flash-exp:free" },
            { label: "Llama 3.3 70B Instruct - Free", value: "meta-llama/llama-3.3-70b-instruct:free" },
            { label: "Qwen 2.5 VL 72B - Free", value: "qwen/qwen-2.5-vl-72b-instruct:free" },
            { label: "DeepSeek R1 - Free", value: "deepseek/deepseek-r1:free" },
            { label: "Mistral Small 3.1 - Free", value: "mistralai/mistral-small-3.1-24b-instruct:free" },
            { label: "Claude 3.5 Haiku", value: "anthropic/claude-3.5-haiku" },
            { label: "GPT-4o Mini", value: "openai/gpt-4o-mini" },
            { label: "GPT-4o", value: "openai/gpt-4o" }
        ]
    },
    endpoint: {
        type: OptionType.STRING,
        description: "Endpoint OpenAI-compatible a utiliser",
        default: DEFAULT_OPENROUTER_ENDPOINT,
        placeholder: "https://openrouter.ai/api/v1/chat/completions"
    },
    maxTokens: {
        type: OptionType.SLIDER,
        description: "Nombre maximum de tokens dans la reponse",
        default: 500,
        markers: [100, 250, 500, 1000, 2000],
        minValue: 50,
        maxValue: 4000,
        stickToMarkers: false
    },
    temperature: {
        type: OptionType.SLIDER,
        description: "Creativite de la reponse (0 = precis, 1 = creatif)",
        default: 0.7,
        markers: [0, 0.3, 0.7, 1.0],
        minValue: 0,
        maxValue: 1,
        stickToMarkers: false
    },
    timeoutSeconds: {
        type: OptionType.SLIDER,
        description: "Temps maximum d'attente pour l'API OpenRouter",
        default: 45,
        markers: [10, 20, 30, 45, 60],
        minValue: 5,
        maxValue: 120,
        stickToMarkers: false
    },
    enableFallbackModels: {
        type: OptionType.BOOLEAN,
        description: "Basculer automatiquement sur d'autres modeles free si le modele principal echoue",
        default: true
    },
    enableMemory: {
        type: OptionType.BOOLEAN,
        description: "Conserver une memoire de conversation par utilisateur",
        default: true
    },
    memoryMessages: {
        type: OptionType.SLIDER,
        description: "Nombre maximum de messages conserves par utilisateur",
        default: 8,
        markers: [2, 4, 8, 12, 16],
        minValue: 0,
        maxValue: 20,
        stickToMarkers: false
    },
    systemPrompt: {
        type: OptionType.STRING,
        description: "Prompt systeme pour personnaliser le comportement de ChatGPT",
        default: "Tu es un assistant utile et amical. Reponds de maniere concise et claire.",
        placeholder: "Tu es un assistant..."
    },
    includeModelTag: {
        type: OptionType.BOOLEAN,
        description: "Afficher le modele utilise dans la reponse",
        default: true
    },
    enableNotifications: {
        type: OptionType.BOOLEAN,
        description: "Afficher des notifications pour les erreurs et succes",
        default: true
    }
});

let isInitialized = false;
const activeRequests = new Set<string>();
let requestCount = 0;
let successCount = 0;
let failureCount = 0;
let lastError = "";
const conversationMemory = new Map<string, ChatMessage[]>();

function notify(title: string, body: string, isError = false) {
    if (!settings.store.enableNotifications) return;

    void showNotification({
        title: isError ? `Erreur: ${title}` : `OK: ${title}`,
        body,
        icon: undefined
    });
}

function validateApiKey(apiKey: string) {
    const trimmed = apiKey.trim();
    return Boolean(trimmed && (trimmed.startsWith("sk-or-v1-") || trimmed.startsWith("sk-")) && trimmed.length > 20);
}

function maskApiKey(apiKey: string) {
    if (!validateApiKey(apiKey)) return "Non configuree";
    const trimmed = apiKey.trim();
    return `${trimmed.slice(0, 7)}...${trimmed.slice(-4)}`;
}

function normalizeResponse(content: string) {
    return content.replace(/\r\n/g, "\n").trim();
}

function getRequestKey(ctx: any) {
    return String(ctx?.user?.id ?? ctx?.author?.id ?? ctx?.message?.author?.id ?? ctx?.channel?.id ?? "global");
}

function getConversationHistory(requestKey: string) {
    if (!settings.store.enableMemory || settings.store.memoryMessages <= 0) return [];
    return conversationMemory.get(requestKey) ?? [];
}

function pushConversationHistory(requestKey: string, userPrompt: string, assistantReply: string) {
    if (!settings.store.enableMemory || settings.store.memoryMessages <= 0) return;

    const current = conversationMemory.get(requestKey) ?? [];
    current.push(
        { role: "user", content: userPrompt },
        { role: "assistant", content: assistantReply }
    );

    const maxMessages = Math.max(0, Math.round(settings.store.memoryMessages));
    conversationMemory.set(requestKey, current.slice(-maxMessages));
}

function clearConversationHistory(requestKey?: string) {
    if (requestKey) {
        conversationMemory.delete(requestKey);
        return;
    }

    conversationMemory.clear();
}

function shouldTryFallback(errorMessage: string) {
    const normalized = errorMessage.toLowerCase();
    return normalized.includes("429")
        || normalized.includes("rate")
        || normalized.includes("tempor")
        || normalized.includes("unavailable")
        || normalized.includes("overloaded")
        || normalized.includes("503")
        || normalized.includes("502");
}

function getModelCandidates(selectedModel: string) {
    return [selectedModel, ...FREE_FALLBACK_MODELS.filter(model => model !== selectedModel)];
}

function splitMessage(content: string, limit = DISCORD_MESSAGE_LIMIT) {
    if (content.length <= limit) return [content];

    const parts: string[] = [];
    let remaining = content;

    while (remaining.length > limit) {
        let cut = remaining.lastIndexOf("\n", limit);
        if (cut < limit / 2) cut = remaining.lastIndexOf(" ", limit);
        if (cut < limit / 2) cut = limit;

        parts.push(remaining.slice(0, cut).trim());
        remaining = remaining.slice(cut).trim();
    }

    if (remaining) parts.push(remaining);
    return parts.filter(Boolean);
}

async function sendResponse(channelId: string, response: string, model: string) {
    const prefix = settings.store.includeModelTag ? `🤖 **ChatGPT** (${model})\n\n` : "🤖 **ChatGPT**\n\n";
    const chunks = splitMessage(response, DISCORD_MESSAGE_LIMIT);

    chunks.forEach((chunk, index) => {
        sendBotMessage(channelId, {
            content: index === 0 ? `${prefix}${chunk}` : chunk
        });
    });
}

async function callChatGPT(prompt: string, requestKey: string) {
    const {
        apiKey,
        enableFallbackModels,
        endpoint,
        maxTokens,
        model,
        systemPrompt,
        temperature,
        timeoutSeconds
    } = settings.store;

    const trimmedApiKey = apiKey.trim();
    const selectedModel = model || FREE_FALLBACK_MODELS[0];
    if (!validateApiKey(trimmedApiKey)) {
        throw new Error("Cle API invalide. Configurez une cle valide dans les parametres du plugin.");
    }

    const messages: ChatMessage[] = [
        { role: "system", content: systemPrompt },
        ...getConversationHistory(requestKey),
        { role: "user", content: prompt }
    ];

    const candidates = enableFallbackModels ? getModelCandidates(selectedModel) : [selectedModel];
    let lastAttemptError = "";

    for (const candidateModel of candidates) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), Math.round(timeoutSeconds * 1000));

        try {
            const response = await fetch(endpoint || DEFAULT_OPENROUTER_ENDPOINT, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${trimmedApiKey}`,
                    "HTTP-Referer": "https://github.com/BashOnZsh/Bashcord",
                    "X-Title": OPENROUTER_TITLE
                },
                body: JSON.stringify({
                    model: candidateModel,
                    messages,
                    max_tokens: Math.round(maxTokens),
                    temperature: Math.round(temperature * 100) / 100
                }),
                signal: controller.signal
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({} as any));
                let errorMessage = `Erreur API (${response.status})`;

                if (errorData?.error?.message) {
                    errorMessage += `: ${errorData.error.message}`;
                } else if (response.status === 401) {
                    errorMessage += ": cle API OpenRouter invalide ou expiree";
                } else if (response.status === 429) {
                    errorMessage += ": limite de taux atteinte, reessayez plus tard";
                }

                throw new Error(errorMessage);
            }

            const data = await response.json();
            const content = data?.choices?.[0]?.message?.content;

            if (typeof content !== "string" || !content.trim()) {
                throw new Error("Reponse inattendue de l'API OpenRouter");
            }

            return {
                content: normalizeResponse(content),
                model: candidateModel,
                usedFallback: candidateModel !== selectedModel
            };
        } catch (error) {
            if (error instanceof DOMException && error.name === "AbortError") {
                lastAttemptError = "Requete expiree: l'API OpenRouter a mis trop de temps a repondre";
            } else {
                lastAttemptError = error instanceof Error ? error.message : "Erreur inconnue";
            }

            if (!enableFallbackModels || candidateModel === candidates[candidates.length - 1] || !shouldTryFallback(lastAttemptError)) {
                throw new Error(lastAttemptError);
            }
        } finally {
            clearTimeout(timeout);
        }
    }

    throw new Error(lastAttemptError || "Aucun modele OpenRouter n'a reussi a repondre");
}

export default definePlugin({
    name: "ChatGPT",
    description: "Permet d'utiliser ChatGPT directement dans Discord avec parametres configurables",
    authors: [{
        name: "Bash",
        id: 1327483363518582784n
    }],
    dependencies: ["CommandsAPI"],
    settings,
    commands: [
        {
            inputType: ApplicationCommandInputType.BUILT_IN,
            name: "chatgpt",
            description: "Posez une question a ChatGPT",
            options: [
                {
                    name: "question",
                    description: "Votre question pour ChatGPT",
                    type: ApplicationCommandOptionType.STRING,
                    required: true
                }
            ],
            execute: async (opts, ctx) => {
                const requestKey = getRequestKey(ctx);
                const question = opts.find(opt => opt.name === "question")?.value;

                if (!question || typeof question !== "string") {
                    sendBotMessage(ctx.channel.id, {
                        content: "❌ Aucune question fournie."
                    });
                    return;
                }

                if (activeRequests.has(requestKey)) {
                    sendBotMessage(ctx.channel.id, {
                        content: "⏳ Une requete ChatGPT est deja en cours. Veuillez patienter."
                    });
                    return;
                }

                if (!validateApiKey(settings.store.apiKey)) {
                    sendBotMessage(ctx.channel.id, {
                        content: "❌ Cle API OpenRouter non configuree ou invalide. Configurez-la dans les parametres du plugin ChatGPT."
                    });
                    return;
                }

                activeRequests.add(requestKey);
                requestCount++;

                try {
                    const result = await callChatGPT(question, requestKey);
                    successCount++;
                    lastError = "";

                    pushConversationHistory(requestKey, question, result.content);

                    notify(
                        "ChatGPT",
                        result.usedFallback
                            ? `Reponse generee via fallback: ${result.model}`
                            : "Reponse generee avec succes"
                    );
                    await sendResponse(ctx.channel.id, result.content, result.model);
                } catch (error) {
                    failureCount++;
                    lastError = error instanceof Error ? error.message : "Erreur inconnue";
                    console.error("[ChatGPT] Erreur lors de l'execution de la commande:", error);

                    notify("ChatGPT", lastError, true);
                    sendBotMessage(ctx.channel.id, {
                        content: `❌ **Erreur ChatGPT**: ${lastError}`
                    });
                } finally {
                    activeRequests.delete(requestKey);
                }
            }
        },
        {
            inputType: ApplicationCommandInputType.BUILT_IN,
            name: "chatgpt-info",
            description: "Afficher les informations sur la configuration ChatGPT",
            options: [],
            execute: async (_opts, ctx) => {
                const requestKey = getRequestKey(ctx);
                const hasValidKey = validateApiKey(settings.store.apiKey);
                const keyStatus = hasValidKey ? "✅ Configuree" : "❌ Non configuree ou invalide";
                const memoryLength = getConversationHistory(requestKey).length;

                sendBotMessage(ctx.channel.id, {
                    content:
                        "🤖 **Configuration ChatGPT / OpenRouter**\n\n" +
                        `**Cle API**: ${keyStatus}\n` +
                        `**Cle masquee**: ${maskApiKey(settings.store.apiKey)}\n` +
                        `**Endpoint**: ${settings.store.endpoint}\n` +
                        `**Modele**: ${settings.store.model}\n` +
                        `**Fallback free**: ${settings.store.enableFallbackModels ? "✅ Active" : "❌ Desactive"}\n` +
                        `**Memoire**: ${settings.store.enableMemory ? `✅ Active (${memoryLength} messages)` : "❌ Desactivee"}\n` +
                        `**Tokens max**: ${settings.store.maxTokens}\n` +
                        `**Temperature**: ${settings.store.temperature}\n` +
                        `**Timeout**: ${settings.store.timeoutSeconds}s\n` +
                        `**Statut**: ${activeRequests.size > 0 ? `⏳ ${activeRequests.size} requete(s) en cours` : "🟢 Pret"}\n` +
                        `**Requetes**: ${requestCount} total / ${successCount} succes / ${failureCount} erreurs\n` +
                        `${lastError ? `**Derniere erreur**: ${lastError}\n` : ""}` +
                        `\n${!hasValidKey ? "⚠️ Configurez votre cle API OpenRouter dans les parametres du plugin." : ""}`
                });
            }
        },
        {
            inputType: ApplicationCommandInputType.BUILT_IN,
            name: "chatgpt-reset",
            description: "Effacer la memoire ChatGPT pour votre utilisateur",
            options: [],
            execute: async (_opts, ctx) => {
                clearConversationHistory(getRequestKey(ctx));
                sendBotMessage(ctx.channel.id, {
                    content: "🧹 Memoire ChatGPT effacee pour votre utilisateur."
                });
            }
        }
    ],
    start() {
        if (isInitialized) return;

        isInitialized = true;
        activeRequests.clear();

        if (!validateApiKey(settings.store.apiKey)) {
            notify(
                "ChatGPT Plugin",
                "Cle API OpenRouter non configuree. Configurez votre cle dans les parametres du plugin.",
                true
            );
            return;
        }

        notify("ChatGPT Plugin", "Plugin active avec succes.");
    },
    stop() {
        isInitialized = false;
        activeRequests.clear();
        clearConversationHistory();
        notify("ChatGPT Plugin", "Plugin desactive.");
    }
});
