<!--
Copyright: Ankitects Pty Ltd and contributors
License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html
-->
<script lang="ts">
    import type { Session } from "@supabase/supabase-js";
    import { onMount } from "svelte";

    import TabIcon from "./TabIcon.svelte";
    import {
        deleteRemoteCard,
        insertRemoteCard,
        insertRemoteCards,
        insertRemoteReviewLog,
        loadRemoteCollection,
        replaceRemoteCollection,
        updateRemoteCard,
    } from "./remote";
    import {
        answerCard,
        createCard,
        createEmptyCollection,
        dueCards,
        formatDateTime,
        nextDueLabel,
        previewsForCard,
        retentionPercent,
        reviewsToday,
        studyStreakDays,
        upcomingCards,
        type CollectionSettings,
        type Rating,
        type ReviewLogEntry,
        type SrsCard,
        type SrsCollection,
    } from "./scheduler";
    import { supabase } from "./supabase";

    type Tab = "review" | "create" | "cards" | "files" | "stats" | "account";
    type ImportKind = "json" | "csv";
    type ImportMode = "merge" | "replace";
    type ReviewMode = "due" | "random";
    type AiChatMessage = {
        id: string;
        role: "user" | "model";
        text: string;
    };

    const storageKey = "anki.personal-srs.collection.v1";
    const geminiApiKeyStorageKey = "anki.personal-srs.gemini-api-key.v1";
    const fontScaleStorageKey = "anki.personal-srs.font-scale.v1";
    const geminiModel = "gemini-3.1-flash-lite";
    const aiPromptPresets = [
        {
            label: "예제",
            prompt: "이 카드 답을 자연스럽게 쓰는 짧은 예문 2개와 한국어 뜻을 보여줘.",
        },
        {
            label: "설명",
            prompt: "이 카드의 답을 초보자도 이해하기 쉽게 핵심만 설명해줘.",
        },
    ];
    const tabs: { id: Tab; label: string }[] = [
        { id: "review", label: "복습" },
        { id: "create", label: "추가" },
        { id: "cards", label: "카드" },
        { id: "files", label: "파일" },
        { id: "stats", label: "통계" },
        { id: "account", label: "계정" },
    ];

    let collection: SrsCollection = createEmptyCollection();
    let session: Session | null = null;
    let authReady = false;
    let syncing = false;
    let syncStatus = "";
    let activeTab: Tab = "review";
    let menuOpen = false;
    let reviewMode: ReviewMode = "due";
    let randomQueueIds: string[] = [];
    let reviewStatus = "";
    let schedulerNow = new Date();
    let loaded = false;
    let showBack = false;
    let createFront = "";
    let createBack = "";
    let createDeck = "Default";
    let createTags = "";
    let createSource = "";
    let createStatus = "";
    let search = "";
    let editingId: string | null = null;
    let editFront = "";
    let editBack = "";
    let editDeck = "";
    let editTags = "";
    let editSource = "";
    let importMode: ImportMode = "merge";
    let pendingImportKind: ImportKind = "json";
    let fileInput: HTMLInputElement;
    let fileStatus = "";
    let geminiApiKey = "";
    let geminiApiKeyInput = "";
    let aiChatsByCard: Record<string, AiChatMessage[]> = {};
    let aiDraft = "";
    let aiStatus = "";
    let aiLoading = false;
    let aiCardId = "";
    let aiPromptMenuOpen = false;
    let aiChatOpen = false;
    let cardFontScale = 1;

    $: due = dueCards(collection.cards, schedulerNow);
    $: upcoming = upcomingCards(collection.cards, schedulerNow);
    $: if (reviewMode === "random") {
        const dueIds = new Set(due.map((card) => card.id));
        const validQueue = randomQueueIds.filter((id) => dueIds.has(id));
        if (validQueue.length !== randomQueueIds.length) {
            randomQueueIds = validQueue;
        } else if (!randomQueueIds.length && due.length) {
            randomQueueIds = shuffledIds(due);
        }
    }
    $: currentCard =
        reviewMode === "random"
            ? (due.find((card) => card.id === randomQueueIds[0]) ?? due[0] ?? null)
            : (due[0] ?? null);
    $: ratingPreviews = currentCard
        ? previewsForCard(currentCard, collection.settings, schedulerNow)
        : [];
    $: filteredCards = filteredCardList(collection.cards, search);
    $: todayReviews = reviewsToday(collection.reviewLog);
    $: streak = studyStreakDays(collection.reviewLog);
    $: retention = retentionPercent(collection.reviewLog);
    $: matureCards = collection.cards.filter((card) => card.intervalDays >= 21).length;
    $: userId = session?.user.id ?? "";
    $: userEmail = session?.user.email ?? "Google account";
    $: geminiKeySaved = Boolean(geminiApiKey);
    $: currentAiMessages = currentCard ? (aiChatsByCard[currentCard.id] ?? []) : [];
    $: cardFontScaleLabel = `${Math.round(cardFontScale * 100)}%`;
    $: cardFontScaleProgress = `${Math.round(((cardFontScale - 0.85) / 0.5) * 100)}%`;
    $: if (loaded && session) {
        localStorage.setItem(storageKey, JSON.stringify(collection));
    }
    $: if (currentCard?.id !== aiCardId) {
        aiStatus = "";
        aiDraft = "";
        aiPromptMenuOpen = false;
        aiChatOpen = false;
        aiCardId = currentCard?.id ?? "";
    }

    onMount(() => {
        let unsubscribe: (() => void) | undefined;
        const schedulerTimer = window.setInterval(() => {
            schedulerNow = new Date();
        }, 15_000);
        geminiApiKey = localStorage.getItem(geminiApiKeyStorageKey) ?? "";
        geminiApiKeyInput = geminiApiKey;
        cardFontScale = readStoredFontScale();

        async function initAuth(): Promise<void> {
            const sessionResult = await supabase.auth.getSession();
            session = sessionResult.data.session;
            authReady = true;

            if (session) {
                await refreshRemoteCollection(session.user.id);
            }

            const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
                session = nextSession;
                if (nextSession) {
                    void refreshRemoteCollection(nextSession.user.id);
                } else {
                    collection = createEmptyCollection();
                    loaded = false;
                }
            });
            unsubscribe = () => data.subscription.unsubscribe();
        }

        void initAuth();
        return () => {
            unsubscribe?.();
            window.clearInterval(schedulerTimer);
        };
    });

    async function signInWithGoogle(): Promise<void> {
        syncStatus = "";
        const { error } = await supabase.auth.signInWithOAuth({
            provider: "google",
            options: {
                redirectTo: window.location.origin,
            },
        });

        if (error) {
            syncStatus = error.message;
        }
    }

    async function signOut(): Promise<void> {
        await supabase.auth.signOut();
    }

    async function refreshRemoteCollection(nextUserId = userId): Promise<void> {
        if (!nextUserId) {
            return;
        }

        syncing = true;
        try {
            collection = await loadRemoteCollection(nextUserId);
            loaded = true;
            syncStatus = "Synced.";
        } catch (error) {
            collection = loadCollection();
            loaded = true;
            syncStatus = error instanceof Error ? error.message : "Sync failed.";
        } finally {
            syncing = false;
        }
    }

    function switchTab(tab: Tab): void {
        activeTab = tab;
        menuOpen = false;
        showBack = false;
        createStatus = "";
        fileStatus = "";
        reviewStatus = "";
    }

    function setReviewMode(mode: ReviewMode): void {
        reviewMode = mode;
        showBack = false;
        reviewStatus = "";
        randomQueueIds = mode === "random" ? shuffledIds(due) : [];
    }

    function toggleMenu(): void {
        menuOpen = !menuOpen;
    }

    function saveGeminiApiKey(): void {
        const trimmed = geminiApiKeyInput.trim();
        if (!trimmed) {
            aiStatus = "Enter a Gemini API key first.";
            return;
        }

        geminiApiKey = trimmed;
        localStorage.setItem(geminiApiKeyStorageKey, trimmed);
        aiStatus = "Gemini API key saved.";
    }

    function clearGeminiApiKey(): void {
        geminiApiKey = "";
        geminiApiKeyInput = "";
        localStorage.removeItem(geminiApiKeyStorageKey);
        aiChatsByCard = {};
        aiDraft = "";
        aiPromptMenuOpen = false;
        aiChatOpen = false;
        aiStatus = "Gemini API key removed.";
    }

    function updateCardFontScale(value: string | number): void {
        const next = clampFontScale(Number(value));
        cardFontScale = next;
        localStorage.setItem(fontScaleStorageKey, String(next));
    }

    function adjustCardFontScale(delta: number): void {
        updateCardFontScale(Number((cardFontScale + delta).toFixed(2)));
    }

    function readStoredFontScale(): number {
        return clampFontScale(Number(localStorage.getItem(fontScaleStorageKey) ?? 1));
    }

    function clampFontScale(value: number): number {
        if (!Number.isFinite(value)) {
            return 1;
        }
        return Math.min(1.35, Math.max(0.85, value));
    }

    function flipCurrentCard(): void {
        if (currentCard) {
            showBack = !showBack;
        }
    }

    function handleFlipKey(event: KeyboardEvent): void {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            flipCurrentCard();
        }
    }

    async function sendAiChatMessage(questionValue = aiDraft): Promise<void> {
        if (!currentCard) {
            return;
        }
        const question = questionValue.trim();
        if (!question) {
            aiStatus = "Type a question for this card first.";
            return;
        }
        if (!geminiApiKey) {
            aiStatus = "Save a Gemini API key in Account first.";
            return;
        }

        const card = currentCard;
        const previousMessages = aiChatsByCard[card.id] ?? [];
        const userMessage: AiChatMessage = {
            id: `ai_${Math.random().toString(36).slice(2)}`,
            role: "user",
            text: question,
        };
        const outgoingMessages = [...previousMessages, userMessage];
        aiChatsByCard = {
            ...aiChatsByCard,
            [card.id]: outgoingMessages,
        };
        aiDraft = "";
        aiPromptMenuOpen = false;
        aiChatOpen = true;
        aiLoading = true;
        aiStatus = "";
        try {
            const response = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "x-goog-api-key": geminiApiKey,
                    },
                    body: JSON.stringify({
                        systemInstruction: {
                            parts: [{ text: buildAiChatSystemPrompt(card) }],
                        },
                        contents: outgoingMessages.map((message) => ({
                            role: message.role,
                            parts: [{ text: message.text }],
                        })),
                        generationConfig: {
                            temperature: 0.35,
                            maxOutputTokens: 700,
                        },
                    }),
                },
            );
            const payload = await response.json();
            if (!response.ok) {
                throw new Error(payload?.error?.message ?? "Gemini request failed.");
            }

            const text = payload?.candidates?.[0]?.content?.parts
                ?.map((part: { text?: string }) => part.text ?? "")
                .join("")
                .trim();
            if (!text) {
                throw new Error("Gemini returned an empty answer.");
            }
            const modelMessage: AiChatMessage = {
                id: `ai_${Math.random().toString(36).slice(2)}`,
                role: "model",
                text,
            };
            aiChatsByCard = {
                ...aiChatsByCard,
                [card.id]: [...outgoingMessages, modelMessage],
            };
            aiStatus = "";
        } catch (error) {
            aiStatus = error instanceof Error ? error.message : "Gemini chat failed.";
        } finally {
            aiLoading = false;
        }
    }

    function sendAiPresetPrompt(prompt: string): void {
        aiDraft = "";
        aiPromptMenuOpen = false;
        aiChatOpen = true;
        void sendAiChatMessage(prompt);
    }

    function clearAiChat(): void {
        if (!currentCard) {
            return;
        }
        const next = { ...aiChatsByCard };
        delete next[currentCard.id];
        aiChatsByCard = next;
        aiDraft = "";
        aiPromptMenuOpen = false;
        aiChatOpen = false;
        aiStatus = "";
    }

    function buildAiChatSystemPrompt(card: SrsCard): string {
        return [
            "You are a concise Korean study tutor inside a personal SRS flashcard app.",
            "Answer only about the current card unless the learner asks for a directly related comparison.",
            "Use compact Markdown, short examples, and memory cues when useful.",
            "Keep each reply focused and under 180 Korean words unless the learner asks for more detail.",
            "",
            "Current flashcard:",
            `Front:\n${normalizeMarkdownInput(card.front)}`,
            "",
            `Back:\n${normalizeMarkdownInput(card.back)}`,
        ].join("\n");
    }

    async function addCard(): Promise<void> {
        if (!createFront.trim() || !createBack.trim()) {
            createStatus = "Front and back are required.";
            return;
        }
        if (!userId) {
            createStatus = "Sign in first.";
            return;
        }

        const card = createCard(createFront, createBack, {
            deck: createDeck,
            tags: splitTags(createTags),
            source: createSource.trim() || undefined,
        });

        syncing = true;
        try {
            const savedCard = await insertRemoteCard(card, userId);
            collection = { ...collection, cards: [savedCard, ...collection.cards] };
            createFront = "";
            createBack = "";
            createSource = "";
            createStatus = "Card saved.";
        } catch (error) {
            createStatus = error instanceof Error ? error.message : "Save failed.";
        } finally {
            syncing = false;
        }
    }

    async function review(rating: Rating): Promise<void> {
        if (!currentCard || !showBack) {
            return;
        }
        if (!userId) {
            syncStatus = "Sign in first.";
            return;
        }

        const result = answerCard(currentCard, rating, collection.settings);
        collection = {
            ...collection,
            cards: collection.cards.map((card) =>
                card.id === result.card.id ? result.card : card,
            ),
            reviewLog: [result.log, ...collection.reviewLog],
        };
        randomQueueIds = randomQueueIds.filter((id) => id !== result.card.id);
        reviewStatus = formatReviewOutcome(result.log, result.card);
        showBack = false;
        syncing = true;
        try {
            const savedCard = await updateRemoteCard(result.card);
            const savedLog = await insertRemoteReviewLog(result.log, userId);
            collection = {
                ...collection,
                cards: collection.cards.map((card) =>
                    card.id === savedCard.id ? savedCard : card,
                ),
                reviewLog: collection.reviewLog.map((entry) =>
                    entry.id === result.log.id ? savedLog : entry,
                ),
            };
            reviewStatus = formatReviewOutcome(savedLog, savedCard);
        } catch (error) {
            syncStatus = error instanceof Error ? error.message : "Review failed.";
        } finally {
            syncing = false;
        }
    }

    function startEditing(card: SrsCard): void {
        editingId = card.id;
        editFront = card.front;
        editBack = card.back;
        editDeck = card.deck;
        editTags = card.tags.join(", ");
        editSource = card.source ?? "";
    }

    async function saveEdit(): Promise<void> {
        if (!editingId || !editFront.trim() || !editBack.trim()) {
            return;
        }

        const updatedAt = new Date().toISOString();
        const existing = collection.cards.find((card) => card.id === editingId);
        if (!existing) {
            return;
        }

        const updated: SrsCard = {
            ...existing,
            front: editFront.trim(),
            back: editBack.trim(),
            deck: editDeck.trim() || "Default",
            tags: splitTags(editTags),
            source: editSource.trim() || undefined,
            updatedAt,
        };

        syncing = true;
        try {
            const savedCard = await updateRemoteCard(updated);
            collection = {
                ...collection,
                cards: collection.cards.map((card) =>
                    card.id === savedCard.id ? savedCard : card,
                ),
            };
            editingId = null;
        } catch (error) {
            syncStatus = error instanceof Error ? error.message : "Save failed.";
        } finally {
            syncing = false;
        }
    }

    async function deleteCard(cardId: string): Promise<void> {
        syncing = true;
        try {
            await deleteRemoteCard(cardId);
            collection = {
                ...collection,
                cards: collection.cards.filter((card) => card.id !== cardId),
                reviewLog: collection.reviewLog.filter(
                    (entry) => entry.cardId !== cardId,
                ),
            };
            if (editingId === cardId) {
                editingId = null;
            }
        } catch (error) {
            syncStatus = error instanceof Error ? error.message : "Delete failed.";
        } finally {
            syncing = false;
        }
    }

    function chooseFile(kind: ImportKind): void {
        pendingImportKind = kind;
        fileInput.value = "";
        fileInput.accept = kind === "json" ? ".json,application/json" : ".csv,text/csv";
        fileInput.click();
    }

    async function importFile(event: Event): Promise<void> {
        const target = event.currentTarget as HTMLInputElement;
        const file = target.files?.[0];
        if (!file) {
            return;
        }

        try {
            const text = await file.text();
            const incoming =
                pendingImportKind === "json"
                    ? collectionFromJson(text)
                    : collectionFromCsv(text);
            if (!userId) {
                fileStatus = "Sign in first.";
                return;
            }

            syncing = true;
            const savedCards =
                importMode === "replace"
                    ? await replaceRemoteCollection(incoming.cards, userId)
                    : await insertRemoteCards(incoming.cards, userId);
            collection =
                importMode === "replace"
                    ? { ...createEmptyCollection(), cards: savedCards }
                    : {
                          ...collection,
                          cards: [...savedCards, ...collection.cards],
                      };
            fileStatus = `${savedCards.length} cards imported.`;
        } catch (error) {
            fileStatus = error instanceof Error ? error.message : "Import failed.";
        } finally {
            syncing = false;
        }
    }

    function exportJson(): void {
        const payload = JSON.stringify(collection, null, 2);
        const blob = new Blob([payload], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `personal-srs-${new Date().toISOString().slice(0, 10)}.json`;
        link.click();
        URL.revokeObjectURL(url);
        fileStatus = `${collection.cards.length} cards exported.`;
    }

    function loadCollection(): SrsCollection {
        const saved = localStorage.getItem(storageKey);
        if (!saved) {
            return createEmptyCollection();
        }

        try {
            return normalizeCollection(JSON.parse(saved));
        } catch {
            return createEmptyCollection();
        }
    }

    function filteredCardList(cards: SrsCard[], query: string): SrsCard[] {
        const needle = query.trim().toLowerCase();
        if (!needle) {
            return cards;
        }

        return cards.filter((card) =>
            [card.front, card.back, card.deck, card.tags.join(" ")]
                .join(" ")
                .toLowerCase()
                .includes(needle),
        );
    }

    function shuffledIds(cards: SrsCard[]): string[] {
        const ids = cards.map((card) => card.id);
        for (let index = ids.length - 1; index > 0; index -= 1) {
            const swapIndex = Math.floor(Math.random() * (index + 1));
            [ids[index], ids[swapIndex]] = [ids[swapIndex], ids[index]];
        }
        return ids;
    }

    function formatReviewOutcome(entry: ReviewLogEntry, card: SrsCard): string {
        return `${entry.rating.toUpperCase()} -> ${entry.nextPhase}, next ${nextDueLabel(card)}`;
    }

    function renderMarkdown(value: string): string {
        const lines = escapeHtml(normalizeMarkdownInput(value))
            .replace(/\r\n?/g, "\n")
            .split("\n");
        const blocks: string[] = [];
        let index = 0;

        while (index < lines.length) {
            const line = lines[index];
            const trimmed = line.trim();

            if (!trimmed) {
                index += 1;
                continue;
            }

            if (trimmed.startsWith("```")) {
                const codeLines: string[] = [];
                index += 1;
                while (index < lines.length && !lines[index].trim().startsWith("```")) {
                    codeLines.push(lines[index]);
                    index += 1;
                }
                index += 1;
                blocks.push(`<pre><code>${codeLines.join("\n")}</code></pre>`);
                continue;
            }

            const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed);
            if (heading) {
                const level = heading[1].length + 2;
                blocks.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
                index += 1;
                continue;
            }

            if (/^[-*]\s+/.test(trimmed)) {
                const items: string[] = [];
                while (index < lines.length && /^[-*]\s+/.test(lines[index].trim())) {
                    items.push(
                        `<li>${inlineMarkdown(lines[index].trim().replace(/^[-*]\s+/, ""))}</li>`,
                    );
                    index += 1;
                }
                blocks.push(`<ul>${items.join("")}</ul>`);
                continue;
            }

            if (/^\d+\.\s+/.test(trimmed)) {
                const items: string[] = [];
                while (index < lines.length && /^\d+\.\s+/.test(lines[index].trim())) {
                    items.push(
                        `<li>${inlineMarkdown(lines[index].trim().replace(/^\d+\.\s+/, ""))}</li>`,
                    );
                    index += 1;
                }
                blocks.push(`<ol>${items.join("")}</ol>`);
                continue;
            }

            if (trimmed.startsWith("&gt;")) {
                const quoteLines: string[] = [];
                while (index < lines.length && lines[index].trim().startsWith("&gt;")) {
                    quoteLines.push(lines[index].trim().replace(/^&gt;\s?/, ""));
                    index += 1;
                }
                blocks.push(
                    `<blockquote>${quoteLines.map(inlineMarkdown).join("<br>")}</blockquote>`,
                );
                continue;
            }

            const paragraphLines = [trimmed];
            index += 1;
            while (index < lines.length && lines[index].trim()) {
                const next = lines[index].trim();
                if (
                    next.startsWith("```") ||
                    /^(#{1,3})\s+/.test(next) ||
                    /^[-*]\s+/.test(next) ||
                    /^\d+\.\s+/.test(next)
                ) {
                    break;
                }
                paragraphLines.push(next);
                index += 1;
            }
            blocks.push(`<p>${paragraphLines.map(inlineMarkdown).join("<br>")}</p>`);
        }

        return blocks.join("");
    }

    function normalizeMarkdownInput(value: string): string {
        let normalized = value.replace(/\\n/g, "\n").replace(/\r\n?/g, "\n").trim();
        const legacyPromptMatch =
            /^#{1,3}\s+(.+?)\s+(?:\n\s*)?뜻을 떠올린 뒤 카드를 뒤집으세요\.?$/.exec(
                normalized,
            );
        if (legacyPromptMatch) {
            return legacyPromptMatch[1].trim();
        }

        if (!normalized.includes("\n") && /^#{1,3}\s/.test(normalized)) {
            normalized = normalized
                .replace(/\s+(#{1,3})\s+/g, "\n\n$1 ")
                .replace(/\s+-\s+/g, "\n");
        }

        return normalized;
    }

    function inlineMarkdown(value: string): string {
        return value
            .replace(/`([^`]+)`/g, "<code>$1</code>")
            .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
            .replace(/\*([^*]+)\*/g, "<em>$1</em>")
            .replace(
                /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
                '<a href="$2" target="_blank" rel="noreferrer">$1</a>',
            );
    }

    function escapeHtml(value: string): string {
        return value
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#039;");
    }

    function collectionFromJson(text: string): SrsCollection {
        return normalizeCollection(JSON.parse(text));
    }

    function collectionFromCsv(text: string): SrsCollection {
        const rows = parseCsv(text).filter((row) => row.some((cell) => cell.trim()));
        if (!rows.length) {
            throw new Error("CSV is empty.");
        }

        const header = rows[0].map((cell) => cell.trim().toLowerCase());
        const hasHeader = header.includes("front") && header.includes("back");
        const body = hasHeader ? rows.slice(1) : rows;
        const frontIndex = hasHeader ? header.indexOf("front") : 0;
        const backIndex = hasHeader ? header.indexOf("back") : 1;
        const deckIndex = hasHeader ? header.indexOf("deck") : 2;
        const tagsIndex = hasHeader ? header.indexOf("tags") : 3;
        const sourceIndex = hasHeader ? header.indexOf("source") : 4;
        const cards = body
            .map((row) =>
                createCard(
                    normalizeImportedText(row[frontIndex] ?? ""),
                    normalizeImportedText(row[backIndex] ?? ""),
                    {
                        deck: row[deckIndex] || "Default",
                        tags: splitTags(row[tagsIndex] ?? ""),
                        source: row[sourceIndex] || undefined,
                    },
                ),
            )
            .filter((card) => card.front && card.back);

        return { ...createEmptyCollection(), cards };
    }

    function normalizeCollection(value: unknown): SrsCollection {
        if (Array.isArray(value)) {
            return {
                ...createEmptyCollection(),
                cards: value.map(cardFromLooseObject).filter(Boolean) as SrsCard[],
            };
        }

        if (!isRecord(value)) {
            throw new Error("JSON must be a collection object or a card array.");
        }

        const cardsValue = Array.isArray(value.cards) ? value.cards : [];
        const logValue = Array.isArray(value.reviewLog) ? value.reviewLog : [];
        return {
            version: 1,
            settings: normalizeSettings(value.settings),
            cards: cardsValue.map(cardFromLooseObject).filter(Boolean) as SrsCard[],
            reviewLog: logValue.filter(isRecord).map((entry) => ({
                id: String(entry.id ?? `review_${Math.random().toString(36).slice(2)}`),
                cardId: String(entry.cardId ?? ""),
                rating: isRating(entry.rating) ? entry.rating : "good",
                reviewedAt: String(entry.reviewedAt ?? new Date().toISOString()),
                previousPhase: isPhase(entry.previousPhase)
                    ? entry.previousPhase
                    : "review",
                nextPhase: isPhase(entry.nextPhase) ? entry.nextPhase : "review",
                previousIntervalDays: Number(entry.previousIntervalDays ?? 0),
                nextIntervalDays: Number(entry.nextIntervalDays ?? 0),
                easeFactor: Number(entry.easeFactor ?? 2.5),
            })),
        };
    }

    function normalizeSettings(value: unknown): CollectionSettings {
        const base = createEmptyCollection().settings;
        if (!isRecord(value)) {
            return base;
        }

        return {
            learningStepsMinutes: numberArray(
                value.learningStepsMinutes,
                base.learningStepsMinutes,
            ),
            relearningStepsMinutes: numberArray(
                value.relearningStepsMinutes,
                base.relearningStepsMinutes,
            ),
            graduatingIntervalGoodDays: positiveNumber(
                value.graduatingIntervalGoodDays,
                base.graduatingIntervalGoodDays,
            ),
            graduatingIntervalEasyDays: positiveNumber(
                value.graduatingIntervalEasyDays,
                base.graduatingIntervalEasyDays,
            ),
            hardMultiplier: positiveNumber(value.hardMultiplier, base.hardMultiplier),
            easyMultiplier: positiveNumber(value.easyMultiplier, base.easyMultiplier),
            intervalMultiplier: positiveNumber(
                value.intervalMultiplier,
                base.intervalMultiplier,
            ),
            lapseMultiplier: nonNegativeNumber(
                value.lapseMultiplier,
                base.lapseMultiplier,
            ),
            minimumLapseIntervalDays: positiveNumber(
                value.minimumLapseIntervalDays,
                base.minimumLapseIntervalDays,
            ),
            maximumReviewIntervalDays: positiveNumber(
                value.maximumReviewIntervalDays,
                base.maximumReviewIntervalDays,
            ),
        };
    }

    function cardFromLooseObject(value: unknown): SrsCard | null {
        if (!isRecord(value)) {
            return null;
        }

        const front = normalizeImportedText(
            String(value.front ?? value.question ?? ""),
        );
        const back = normalizeImportedText(String(value.back ?? value.answer ?? ""));
        if (!front || !back) {
            return null;
        }

        const now = new Date().toISOString();
        return {
            id: String(value.id ?? `card_${Math.random().toString(36).slice(2)}`),
            deck: String(value.deck ?? "Default"),
            front,
            back,
            tags: Array.isArray(value.tags)
                ? value.tags.map(String)
                : splitTags(String(value.tags ?? "")),
            source: value.source ? String(value.source) : undefined,
            phase: isPhase(value.phase) ? value.phase : "new",
            dueAt: String(value.dueAt ?? now),
            createdAt: String(value.createdAt ?? now),
            updatedAt: String(value.updatedAt ?? now),
            lastReviewedAt: value.lastReviewedAt
                ? String(value.lastReviewedAt)
                : undefined,
            intervalDays: Number(value.intervalDays ?? 0),
            easeFactor: Number(value.easeFactor ?? 2.5),
            learningStep: Number(value.learningStep ?? 0),
            lapses: Number(value.lapses ?? 0),
            reps: Number(value.reps ?? 0),
        };
    }

    function normalizeImportedText(value: string): string {
        return value
            .replace(/\uFEFF/g, "")
            .replace(/\\n/g, "\n")
            .replace(/\r\n?/g, "\n")
            .trim();
    }

    function parseCsv(text: string): string[][] {
        const rows: string[][] = [];
        let row: string[] = [];
        let cell = "";
        let quoted = false;

        for (let index = 0; index < text.length; index += 1) {
            const char = text[index];
            const next = text[index + 1];

            if (char === '"' && quoted && next === '"') {
                cell += '"';
                index += 1;
            } else if (char === '"') {
                quoted = !quoted;
            } else if (char === "," && !quoted) {
                row.push(cell);
                cell = "";
            } else if ((char === "\n" || char === "\r") && !quoted) {
                if (char === "\r" && next === "\n") {
                    index += 1;
                }
                row.push(cell);
                rows.push(row);
                row = [];
                cell = "";
            } else {
                cell += char;
            }
        }

        row.push(cell);
        rows.push(row);
        return rows;
    }

    function splitTags(value: string): string[] {
        return value
            .split(/[,\s]+/)
            .map((tag) => tag.trim())
            .filter(Boolean);
    }

    function numberArray(value: unknown, fallback: number[]): number[] {
        if (!Array.isArray(value)) {
            return fallback;
        }

        const numbers = value
            .map(Number)
            .filter((item) => Number.isFinite(item) && item > 0);
        return numbers.length ? numbers : fallback;
    }

    function positiveNumber(value: unknown, fallback: number): number {
        const numberValue = Number(value);
        return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : fallback;
    }

    function nonNegativeNumber(value: unknown, fallback: number): number {
        const numberValue = Number(value);
        return Number.isFinite(numberValue) && numberValue >= 0
            ? numberValue
            : fallback;
    }

    function isRecord(value: unknown): value is Record<string, unknown> {
        return typeof value === "object" && value !== null;
    }

    function isRating(value: unknown): value is Rating {
        return (
            value === "again" ||
            value === "hard" ||
            value === "good" ||
            value === "easy"
        );
    }

    function isPhase(value: unknown): value is SrsCard["phase"] {
        return (
            value === "new" ||
            value === "learning" ||
            value === "review" ||
            value === "relearning"
        );
    }
</script>

<svelte:head>
    <title>Personal SRS</title>
</svelte:head>

<main class="personal-srs" style={`--card-font-scale: ${cardFontScale};`}>
    <section class="app-shell" aria-label="Personal spaced repetition app">
        {#if !authReady}
            <section class="auth-screen" aria-label="계정 불러오는 중">
                <p class="section-label">계정</p>
                <h1>Personal SRS</h1>
                <p>세션을 확인하는 중이에요...</p>
                <div class="loading-dots"><span></span><span></span><span></span></div>
            </section>
        {:else if !session}
            <section class="auth-screen" aria-label="로그인">
                <p class="section-label">나만의 플래시카드</p>
                <h1>Personal SRS</h1>
                <p>Google 계정으로 로그인하면 카드와 복습 기록이 자동으로 동기화돼요.</p>
                <button
                    type="button"
                    class="primary-action google-signin"
                    on:click={signInWithGoogle}
                >
                    Google로 계속하기
                </button>
                {#if syncStatus}
                    <p class="inline-status">{syncStatus}</p>
                {/if}
            </section>
        {:else}
            {#if syncing}
                <div class="sync-bar" aria-live="polite" aria-label="동기화 중">
                    <span class="sync-dot"></span>
                    <span>동기화 중...</span>
                </div>
            {/if}

            <nav class="bottom-tab-bar" aria-label="내비게이션">
                {#each tabs as tab}
                    <button
                        type="button"
                        class:active={activeTab === tab.id}
                        aria-current={activeTab === tab.id ? "page" : undefined}
                        on:click={() => switchTab(tab.id)}
                    >
                        <TabIcon name={tab.id} />
                        <span>{tab.label}</span>
                        {#if tab.id === "review" && due.length > 0}
                            <span class="tab-badge">{due.length > 99 ? "99+" : due.length}</span>
                        {/if}
                    </button>
                {/each}
            </nav>

            <section class="workspace">
                {#if activeTab === "review"}
                    <section
                        class="tab-panel review-panel"
                        aria-labelledby="review-title"
                    >
                        <div class="panel-heading">
                            <div>
                                <p class="section-label">암기</p>
                                <h2 id="review-title">복습 큐</h2>
                            </div>
                            <span class="status-pill {due.length > 0 ? 'pill-due' : ''}">{due.length}개 대기</span>
                        </div>

                        <div
                            class="review-controls"
                            role="group"
                            aria-label="복습 순서"
                        >
                            <button
                                type="button"
                                class:active={reviewMode === "due"}
                                on:click={() => setReviewMode("due")}
                            >
                                순서대로
                            </button>
                            <button
                                type="button"
                                class:active={reviewMode === "random"}
                                on:click={() => setReviewMode("random")}
                            >
                                랜덤
                            </button>
                        </div>

                        {#if reviewStatus}
                            <p class="inline-status review-status">{reviewStatus}</p>
                        {/if}

                        {#if currentCard}
                            <div
                                class:flipped={showBack}
                                class="flip-stage"
                                role="button"
                                tabindex="0"
                                aria-label={showBack
                                    ? "Tap to show question"
                                    : "Tap to show answer"}
                                on:click={flipCurrentCard}
                                on:keydown={handleFlipKey}
                            >
                                <article class="study-card flip-card">
                                    <section class="card-face card-front">
                                        <div class="card-meta">
                                            <span>{currentCard.deck}</span>
                                            <span>{currentCard.reps} reps</span>
                                        </div>
                                        <div class="card-center">
                                            <p class="field-label">Front</p>
                                            <div
                                                class="markdown-content question-content"
                                            >
                                                {@html renderMarkdown(
                                                    currentCard.front,
                                                )}
                                            </div>
                                        </div>
                                        <div class="card-footer">
                                            {#if currentCard.tags.length}
                                                <div class="tag-row">
                                                    {#each currentCard.tags as tag}
                                                        <span>{tag}</span>
                                                    {/each}
                                                </div>
                                            {/if}
                                            <p class="tap-hint">탭하여 정답 보기 👆</p>
                                        </div>
                                    </section>

                                    <section class="card-face card-back">
                                        <div class="card-meta">
                                            <span>{currentCard.deck}</span>
                                            <span>{currentCard.phase}</span>
                                        </div>
                                        <div class="card-center">
                                            <p class="field-label">Back</p>
                                            <div
                                                class="markdown-content answer-content"
                                            >
                                                {@html renderMarkdown(currentCard.back)}
                                            </div>
                                        </div>
                                        <div class="card-footer">
                                            {#if currentCard.source}
                                                <a
                                                    href={currentCard.source}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                    on:click|stopPropagation
                                                >
                                                    Source
                                                </a>
                                            {/if}
                                            <p class="tap-hint">탭하여 질문 보기</p>
                                        </div>
                                    </section>
                                </article>
                            </div>

                            {#if showBack}
                                <div class:expanded={aiChatOpen} class="ai-chat-shell">
                                    <button
                                        type="button"
                                        class="ai-hover-button"
                                        aria-expanded={aiChatOpen}
                                        aria-controls="card-ai-chat"
                                        on:click={() => (aiChatOpen = !aiChatOpen)}
                                    >
                                        AI
                                    </button>
                                    <section
                                        id="card-ai-chat"
                                        class="ai-chat"
                                        aria-label="Gemini card chat"
                                    >
                                        <div class="ai-chat-header">
                                            <div>
                                                <p class="field-label">Gemini chat</p>
                                                <h3>Ask about this card</h3>
                                            </div>
                                            <div class="ai-chat-actions">
                                                {#if currentAiMessages.length}
                                                    <button
                                                        type="button"
                                                        class="ghost-action compact"
                                                        on:click={clearAiChat}
                                                    >
                                                        Clear
                                                    </button>
                                                {/if}
                                                <button
                                                    type="button"
                                                    class="ghost-action compact"
                                                    on:click={() =>
                                                        (aiChatOpen = false)}
                                                >
                                                    Close
                                                </button>
                                            </div>
                                        </div>

                                        <div class="ai-thread" aria-live="polite">
                                            {#if currentAiMessages.length}
                                                {#each currentAiMessages as message}
                                                    <article
                                                        class="ai-message {message.role}"
                                                    >
                                                        <span>
                                                            {message.role === "user"
                                                                ? "You"
                                                                : "Gemini"}
                                                        </span>
                                                        <div class="markdown-content">
                                                            {@html renderMarkdown(
                                                                message.text,
                                                            )}
                                                        </div>
                                                    </article>
                                                {/each}
                                            {:else}
                                                <p class="ai-empty">
                                                    Ask for a hint, example sentence,
                                                    memory cue, or why the answer fits
                                                    this card.
                                                </p>
                                            {/if}
                                        </div>

                                        <form
                                            class="ai-composer"
                                            on:submit|preventDefault={sendAiChatMessage}
                                        >
                                            <div class="ai-input-shell">
                                                <textarea
                                                    bind:value={aiDraft}
                                                    rows="2"
                                                    placeholder="Ask a question about this card..."
                                                    disabled={aiLoading}
                                                ></textarea>
                                                <button
                                                    type="button"
                                                    class="ai-plus"
                                                    aria-label="Open prompt shortcuts"
                                                    aria-expanded={aiPromptMenuOpen}
                                                    disabled={aiLoading}
                                                    on:click={() =>
                                                        (aiPromptMenuOpen =
                                                            !aiPromptMenuOpen)}
                                                >
                                                    +
                                                </button>
                                                {#if aiPromptMenuOpen}
                                                    <div class="ai-prompt-menu">
                                                        {#each aiPromptPresets as preset}
                                                            <button
                                                                type="button"
                                                                on:click={() =>
                                                                    sendAiPresetPrompt(
                                                                        preset.prompt,
                                                                    )}
                                                            >
                                                                {preset.label}
                                                            </button>
                                                        {/each}
                                                    </div>
                                                {/if}
                                            </div>
                                            <button
                                                type="submit"
                                                class="ai-action"
                                                disabled={aiLoading}
                                            >
                                                {aiLoading ? "Sending..." : "Send"}
                                            </button>
                                        </form>
                                        {#if aiStatus}
                                            <p class="inline-status">{aiStatus}</p>
                                        {/if}
                                    </section>
                                </div>
                                <div class="rating-grid" aria-label="Answer buttons">
                                    {#each ratingPreviews as preview}
                                        <button
                                            type="button"
                                            class="rating {preview.rating}"
                                            on:click={() => review(preview.rating)}
                                        >
                                            <span>{preview.label}</span>
                                            <small>{preview.dueLabel}</small>
                                        </button>
                                    {/each}
                                </div>
                            {/if}
                        {:else}
                            <div class="empty-state">
                                <div class="empty-icon">🎉</div>
                                <h3>오늘 복습 완료!</h3>
                                {#if upcoming[0]}
                                    <p>다음 카드는 {nextDueLabel(upcoming[0])} 예정이에요.</p>
                                {:else}
                                    <p>대기 중인 카드가 없어요.</p>
                                {/if}
                                <button
                                    type="button"
                                    class="primary-action compact"
                                    on:click={() => switchTab("create")}
                                >
                                    카드 추가하기
                                </button>
                            </div>
                        {/if}
                    </section>
                {:else if activeTab === "create"}
                    <section class="tab-panel" aria-labelledby="create-title">
                        <div class="panel-heading">
                            <div>
                                <p class="section-label">카드 추가</p>
                                <h2 id="create-title">새 카드</h2>
                            </div>
                        </div>

                        <form class="card-form" on:submit|preventDefault={addCard}>
                            <label>
                                <span>덱</span>
                                <input bind:value={createDeck} autocomplete="off" />
                            </label>
                            <label>
                                <span>앞면 (질문)</span>
                                <textarea bind:value={createFront} rows="4" placeholder="외울 단어나 질문을 입력하세요"></textarea>
                            </label>
                            <label>
                                <span>뒷면 (정답)</span>
                                <textarea bind:value={createBack} rows="4" placeholder="정답이나 설명을 입력하세요"></textarea>
                            </label>
                            <label>
                                <span>태그</span>
                                <input
                                    bind:value={createTags}
                                    placeholder="영어, 시험 (쉼표로 구분)"
                                    autocomplete="off"
                                />
                            </label>
                            <label>
                                <span>출처</span>
                                <input
                                    bind:value={createSource}
                                    placeholder="https://..."
                                    autocomplete="off"
                                />
                            </label>
                            <button type="submit" class="primary-action" disabled={syncing}>
                                {syncing ? "저장 중..." : "카드 저장"}
                            </button>
                            {#if createStatus}
                                <p class="inline-status">{createStatus}</p>
                            {/if}
                        </form>
                    </section>
                {:else if activeTab === "cards"}
                    <section class="tab-panel" aria-labelledby="cards-title">
                        <div class="panel-heading">
                            <div>
                                <p class="section-label">관리</p>
                                <h2 id="cards-title">카드 목록</h2>
                            </div>
                            <span class="status-pill">
                                총 {collection.cards.length}장
                            </span>
                        </div>

                        <label class="search-box">
                            <span>검색</span>
                            <input bind:value={search} autocomplete="off" placeholder="앞면, 뒷면, 덱, 태그 검색..." />
                        </label>

                        {#if editingId}
                            <form
                                class="edit-panel"
                                on:submit|preventDefault={saveEdit}
                            >
                                <p class="edit-panel-title">카드 편집</p>
                                <label>
                                    <span>덱</span>
                                    <input bind:value={editDeck} autocomplete="off" />
                                </label>
                                <label>
                                    <span>앞면</span>
                                    <textarea
                                        bind:value={editFront}
                                        rows="4"
                                    ></textarea>
                                </label>
                                <label>
                                    <span>뒷면</span>
                                    <textarea bind:value={editBack} rows="4"></textarea>
                                </label>
                                <label>
                                    <span>태그</span>
                                    <input bind:value={editTags} autocomplete="off" />
                                </label>
                                <label>
                                    <span>출처</span>
                                    <input bind:value={editSource} autocomplete="off" />
                                </label>
                                <div class="button-row">
                                    <button
                                        type="submit"
                                        class="primary-action compact"
                                        disabled={syncing}
                                    >
                                        {syncing ? "저장 중..." : "저장"}
                                    </button>
                                    <button
                                        type="button"
                                        on:click={() => (editingId = null)}
                                    >
                                        취소
                                    </button>
                                </div>
                            </form>
                        {/if}

                        <div class="card-list">
                            {#each filteredCards as card}
                                <article>
                                    <div>
                                        <div class="card-preview-title">
                                            {@html renderMarkdown(card.front)}
                                        </div>
                                        <div class="card-preview-body">
                                            {@html renderMarkdown(card.back)}
                                        </div>
                                        <small>
                                            {card.deck} · {card.phase} · {nextDueLabel(card)}
                                        </small>
                                    </div>
                                    <div class="row-actions">
                                        <button
                                            type="button"
                                            on:click={() => startEditing(card)}
                                        >
                                            편집
                                        </button>
                                        <button
                                            type="button"
                                            class="danger-link"
                                            on:click={() => deleteCard(card.id)}
                                        >
                                            삭제
                                        </button>
                                    </div>
                                </article>
                            {:else}
                                <div class="empty-state compact-empty">
                                    <h3>카드가 없어요</h3>
                                    <button
                                        type="button"
                                        on:click={() => switchTab("create")}
                                    >
                                        카드 추가하기
                                    </button>
                                </div>
                            {/each}
                        </div>
                    </section>
                {:else if activeTab === "files"}
                    <section class="tab-panel" aria-labelledby="files-title">
                        <div class="panel-heading">
                            <div>
                                <p class="section-label">파일</p>
                                <h2 id="files-title">가져오기 / 내보내기</h2>
                            </div>
                        </div>

                        <input
                            bind:this={fileInput}
                            class="hidden-input"
                            type="file"
                            on:change={importFile}
                        />

                        <div class="mode-control" role="group" aria-label="가져오기 방식">
                            <button
                                type="button"
                                class:active={importMode === "merge"}
                                on:click={() => (importMode = "merge")}
                            >
                                병합
                            </button>
                            <button
                                type="button"
                                class:active={importMode === "replace"}
                                on:click={() => (importMode = "replace")}
                            >
                                대체
                            </button>
                        </div>

                        <div class="file-actions">
                            <button type="button" on:click={() => chooseFile("json")}>
                                <strong>JSON 가져오기</strong>
                                <span>컬렉션 JSON 또는 카드 배열</span>
                            </button>
                            <button type="button" on:click={() => chooseFile("csv")}>
                                <strong>CSV 가져오기</strong>
                                <span>front, back, deck, tags, source 열</span>
                            </button>
                            <button type="button" on:click={exportJson}>
                                <strong>JSON 내보내기</strong>
                                <span>
                                    카드 {collection.cards.length}장 · 복습 기록 {collection.reviewLog.length}건
                                </span>
                            </button>
                        </div>

                        {#if fileStatus}
                            <p class="inline-status">{fileStatus}</p>
                        {/if}
                    </section>
                {:else if activeTab === "stats"}
                    <section class="tab-panel" aria-labelledby="stats-title">
                        <div class="panel-heading">
                            <div>
                                <p class="section-label">통계</p>
                                <h2 id="stats-title">학습 현황</h2>
                            </div>
                        </div>

                        <div class="stats-grid">
                            <article>
                                <span>대기 중</span>
                                <strong>{due.length}</strong>
                            </article>
                            <article>
                                <span>오늘 복습</span>
                                <strong>{todayReviews}</strong>
                            </article>
                            <article>
                                <span>연속 학습</span>
                                <strong>{streak}<small>일</small></strong>
                            </article>
                            <article>
                                <span>정답률</span>
                                <strong>{retention}<small>%</small></strong>
                            </article>
                            <article>
                                <span>숙달 카드</span>
                                <strong>{matureCards}</strong>
                            </article>
                            <article>
                                <span>전체 카드</span>
                                <strong>{collection.cards.length}</strong>
                            </article>
                        </div>

                        <p class="section-label" style="margin-top: 0.5rem;">최근 복습</p>
                        <div class="timeline-list">
                            {#each collection.reviewLog.slice(0, 8) as entry}
                                <article>
                                    <span class="rating-badge rating-badge-{entry.rating}">{entry.rating}</span>
                                    <div>
                                        <strong>
                                            {collection.cards.find(
                                                (card) => card.id === entry.cardId,
                                            )?.front ?? "삭제된 카드"}
                                        </strong>
                                        <small>
                                            {formatDateTime(entry.reviewedAt)} · 다음 {entry.nextIntervalDays}일 후
                                        </small>
                                    </div>
                                </article>
                            {:else}
                                <div class="empty-state compact-empty">
                                    <h3>아직 복습 기록이 없어요</h3>
                                </div>
                            {/each}
                        </div>
                    </section>
                {:else}
                    <section
                        class="tab-panel account-panel"
                        aria-labelledby="account-title"
                    >
                        <div class="panel-heading">
                            <div>
                                <p class="section-label">계정</p>
                                <h2 id="account-title">동기화 계정</h2>
                            </div>
                        </div>

                        <div class="account-card">
                            <div>
                                <span>로그인 계정</span>
                                <strong>{userEmail}</strong>
                            </div>
                            <div>
                                <span>동기화 상태</span>
                                <strong class={syncing ? "status-syncing" : ""}>
                                    {syncing ? "동기화 중..." : syncStatus || "준비됨"}
                                </strong>
                            </div>
                            <div>
                                <span>저장된 카드</span>
                                <strong>{collection.cards.length}장</strong>
                            </div>
                            <div>
                                <span>AI 모델</span>
                                <strong>{geminiModel}</strong>
                            </div>
                            <div>
                                <span>Gemini API 키</span>
                                <strong class={geminiKeySaved ? "status-ok" : ""}>
                                    {geminiKeySaved ? "✓ 저장됨" : "저장 안 됨"}
                                </strong>
                            </div>
                        </div>

                        <form
                            class="api-key-form"
                            on:submit|preventDefault={saveGeminiApiKey}
                        >
                            <label>
                                <span>Gemini API 키</span>
                                <input
                                    bind:value={geminiApiKeyInput}
                                    type="password"
                                    placeholder="AIza..."
                                    autocomplete="off"
                                    spellcheck="false"
                                />
                            </label>
                            <div class="button-row">
                                <button type="submit" class="primary-action compact">
                                    키 저장
                                </button>
                                <button type="button" on:click={clearGeminiApiKey}>
                                    키 삭제
                                </button>
                            </div>
                            <p class="profile-note">
                                이 브라우저 프로필에만 저장되며, AI 설명을 요청할 때만 사용돼요.
                            </p>
                        </form>

                        <section class="settings-card" aria-labelledby="display-title">
                            <div class="settings-card-header">
                                <div>
                                    <p class="section-label">화면 설정</p>
                                    <h3 id="display-title">카드 글자 크기</h3>
                                </div>
                                <strong>{cardFontScaleLabel}</strong>
                            </div>
                            <label class="range-setting">
                                <button
                                    type="button"
                                    aria-label="글자 크기 줄이기"
                                    on:click={() => adjustCardFontScale(-0.05)}
                                >
                                    A-
                                </button>
                                <input
                                    type="range"
                                    min="0.85"
                                    max="1.35"
                                    step="0.05"
                                    bind:value={cardFontScale}
                                    style={`--range-progress: ${cardFontScaleProgress};`}
                                    on:input={() => updateCardFontScale(cardFontScale)}
                                />
                                <button
                                    type="button"
                                    aria-label="글자 크기 키우기"
                                    on:click={() => adjustCardFontScale(0.05)}
                                >
                                    A+
                                </button>
                            </label>
                            <button
                                type="button"
                                class="ghost-action compact"
                                on:click={() => updateCardFontScale(1)}
                            >
                                크기 초기화
                            </button>
                        </section>

                        <div class="account-actions">
                            <button
                                type="button"
                                class="primary-action compact"
                                disabled={syncing}
                                on:click={() => refreshRemoteCollection()}
                            >
                                {syncing ? "동기화 중..." : "지금 동기화"}
                            </button>
                            <button
                                type="button"
                                class="danger-link"
                                on:click={signOut}
                            >
                                로그아웃
                            </button>
                        </div>
                    </section>
                {/if}
            </section>
        {/if}
    </section>
</main>

<style>
    :global(body) {
        margin: 0;
        background: linear-gradient(135deg, #eef5f4 0%, #f7f4ec 42%, #eef3f8 100%);
        overflow: hidden;
    }

    :global(html) {
        overflow: hidden;
    }

    :global(*) {
        box-sizing: border-box;
    }

    /* ─── Design tokens ─────────────────────────── */
    .personal-srs {
        --glass-bg: rgba(255, 255, 255, 0.58);
        --glass-strong: rgba(255, 255, 255, 0.82);
        --glass-border: rgba(255, 255, 255, 0.82);
        --content-bg: rgba(255, 255, 255, 0.92);
        --ink: #0d1117;
        --ink-2: #1f2937;
        --muted: #4b5563;
        --muted-lt: #6b7280;
        --line: rgba(100, 130, 140, 0.2);
        --teal: #047481;
        --teal-strong: #005f6b;
        --green: #198754;
        --blue: #2563eb;
        --amber: #b45309;
        --red: #dc2626;
        --shadow-soft: 0 8px 28px rgba(30, 50, 60, 0.09);
        --shadow-lift: 0 18px 52px rgba(30, 50, 60, 0.14);
        --radius-lg: 24px;
        --radius-md: 18px;
        --radius-sm: 12px;
        --tab-bar-h: 4.2rem;
        height: 100dvh;
        overflow: hidden;
        color: var(--ink);
        font-family:
            "Pretendard",
            Inter,
            ui-sans-serif,
            system-ui,
            -apple-system,
            BlinkMacSystemFont,
            "Segoe UI",
            sans-serif;
        letter-spacing: -0.01em;
    }

    /* ─── Shell ──────────────────────────────────── */
    .app-shell {
        display: flex;
        flex-direction: column;
        height: 100dvh;
        min-height: 0;
        max-width: 72rem;
        margin: 0 auto;
        overflow: hidden;
        background: rgba(255, 255, 255, 0.12);
    }

    .app-shell .workspace {
        flex: 1;
        min-height: 0;
    }

    /* ─── Sync bar ───────────────────────────────── */
    .sync-bar {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.4rem 1rem;
        background: rgba(4, 116, 129, 0.08);
        border-bottom: 1px solid rgba(4, 116, 129, 0.12);
        color: var(--teal-strong);
        font-size: 0.8rem;
        font-weight: 700;
        letter-spacing: 0;
    }

    .sync-dot {
        display: inline-block;
        width: 0.55rem;
        height: 0.55rem;
        border-radius: 999px;
        background: var(--teal);
        animation: pulse 1.2s ease-in-out infinite;
    }

    @keyframes pulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.45; transform: scale(0.75); }
    }

    /* ─── Bottom tab bar ──────────────────────────── */
    .bottom-tab-bar {
        position: fixed;
        bottom: 0;
        left: 0;
        right: 0;
        z-index: 100;
        display: grid;
        grid-template-columns: repeat(6, minmax(0, 1fr));
        max-width: 72rem;
        margin: 0 auto;
        padding: 0 0.3rem env(safe-area-inset-bottom, 0.3rem);
        background: rgba(255, 255, 255, 0.82);
        border-top: 1px solid var(--glass-border);
        backdrop-filter: blur(28px) saturate(1.4);
        box-shadow: 0 -4px 24px rgba(30, 50, 60, 0.07);
        height: var(--tab-bar-h);
        align-items: stretch;
    }

    .bottom-tab-bar button {
        position: relative;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 0.22rem;
        min-height: 44px;
        padding: 0.35rem 0.2rem 0.25rem;
        border: 0;
        border-radius: 0;
        background: transparent;
        color: var(--muted-lt);
        font-size: 0.72rem;
        font-weight: 600;
        letter-spacing: -0.01em;
        backdrop-filter: none;
        box-shadow: none;
        transition: color 120ms ease, background 120ms ease;
    }

    .bottom-tab-bar button:hover {
        background: rgba(4, 116, 129, 0.05);
        color: var(--teal);
        transform: none;
        box-shadow: none;
    }

    .bottom-tab-bar button.active {
        color: var(--teal-strong);
    }

    .bottom-tab-bar button.active :global(.tab-icon) {
        stroke: var(--teal-strong);
    }

    .bottom-tab-bar button:focus-visible {
        outline: 2px solid var(--teal);
        outline-offset: -2px;
        border-radius: 8px;
    }

    .tab-badge {
        position: absolute;
        top: 0.3rem;
        right: calc(50% - 1.1rem);
        min-width: 1.2rem;
        height: 1.2rem;
        border-radius: 999px;
        background: var(--red);
        color: #fff;
        font-size: 0.65rem;
        font-weight: 800;
        line-height: 1.2rem;
        text-align: center;
        padding: 0 0.3rem;
    }

    /* ─── Auth ───────────────────────────────────── */
    .auth-screen {
        display: grid;
        align-content: center;
        gap: 1.1rem;
        min-height: 100dvh;
        padding: 2rem 1.5rem;
        max-width: 26rem;
        margin: 0 auto;
        background: transparent;
    }

    .auth-screen p:not(.section-label):not(.inline-status) {
        color: var(--muted);
        line-height: 1.6;
        font-size: 0.95rem;
    }

    .google-signin {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.65rem;
        font-size: 1rem;
    }

    /* Loading dots */
    .loading-dots {
        display: flex;
        gap: 0.4rem;
    }

    .loading-dots span {
        width: 0.55rem;
        height: 0.55rem;
        border-radius: 999px;
        background: var(--teal);
        animation: bounce 0.9s ease-in-out infinite;
    }

    .loading-dots span:nth-child(2) { animation-delay: 0.15s; }
    .loading-dots span:nth-child(3) { animation-delay: 0.3s; }

    @keyframes bounce {
        0%, 60%, 100% { transform: translateY(0); opacity: 0.6; }
        30% { transform: translateY(-0.4rem); opacity: 1; }
    }

    /* ─── Typography ─────────────────────────────── */
    h1, h2, h3, p { margin: 0; }

    h1 {
        font-size: 1.75rem;
        font-weight: 800;
        line-height: 1.1;
        letter-spacing: -0.03em;
        color: var(--ink);
    }

    h2 {
        font-size: 1.3rem;
        font-weight: 750;
        line-height: 1.2;
        color: var(--ink);
    }

    h3 {
        font-size: 1.1rem;
        font-weight: 720;
        line-height: 1.28;
        color: var(--ink);
    }

    button, input, textarea {
        font: inherit;
        letter-spacing: inherit;
    }

    button {
        border: 1px solid var(--line);
        border-radius: var(--radius-sm);
        background: rgba(255, 255, 255, 0.72);
        color: var(--ink);
        cursor: pointer;
        backdrop-filter: blur(16px) saturate(1.2);
        transition:
            transform 100ms ease,
            border-color 100ms ease,
            background 100ms ease,
            box-shadow 100ms ease;
    }

    button:hover {
        border-color: rgba(4, 116, 129, 0.32);
        background: rgba(255, 255, 255, 0.9);
        box-shadow: 0 6px 18px rgba(30, 50, 60, 0.09);
        transform: translateY(-1px);
    }

    button:active {
        transform: translateY(0) scale(0.98);
        box-shadow: none;
    }

    button:disabled {
        opacity: 0.55;
        cursor: not-allowed;
        transform: none !important;
    }

    button:focus-visible,
    input:focus-visible,
    textarea:focus-visible {
        outline: 2.5px solid rgba(4, 116, 129, 0.5);
        outline-offset: 2px;
    }

    input, textarea {
        width: 100%;
        border: 1.5px solid var(--line);
        border-radius: var(--radius-sm);
        background: rgba(255, 255, 255, 0.72);
        color: var(--ink);
        padding: 0.78rem 0.9rem;
        line-height: 1.5;
        resize: none;
        transition: border-color 130ms ease, box-shadow 130ms ease;
    }

    input:focus, textarea:focus {
        border-color: rgba(4, 116, 129, 0.5);
        box-shadow: 0 0 0 3px rgba(4, 116, 129, 0.1);
        outline: none;
    }

    textarea {
        min-height: 7rem;
        white-space: pre-wrap;
    }

    label {
        display: grid;
        gap: 0.4rem;
        color: var(--muted);
        font-size: 0.8rem;
        font-weight: 700;
    }

    label span { text-transform: uppercase; letter-spacing: 0.03em; }

    .section-label,
    .field-label {
        color: var(--teal);
        font-size: 0.72rem;
        font-weight: 800;
        letter-spacing: 0.06em;
        text-transform: uppercase;
    }

    .status-pill {
        border: 1.5px solid var(--line);
        border-radius: 999px;
        background: var(--glass-strong);
        padding: 0.38rem 0.72rem;
        color: var(--muted);
        font-size: 0.8rem;
        font-weight: 700;
        line-height: 1;
        white-space: nowrap;
    }

    .status-pill.pill-due {
        border-color: rgba(4, 116, 129, 0.35);
        color: var(--teal-strong);
        background: rgba(4, 116, 129, 0.07);
    }

    /* ─── Workspace ──────────────────────────────── */
    .workspace {
        min-height: 0;
        overflow: hidden;
        padding: 1rem 0.9rem;
        padding-bottom: calc(var(--tab-bar-h) + 0.5rem);
    }

    .tab-panel {
        display: grid;
        gap: 0.9rem;
        height: 100%;
        min-height: 0;
        overflow: hidden;
    }

    .review-panel {
        position: relative;
        grid-template-rows: auto auto minmax(0, 1fr) auto;
    }

    .review-panel > .flip-stage { grid-row: 3; }
    .review-panel > .rating-grid { grid-row: 4; }

    .panel-heading {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        max-width: 48rem;
    }

    .panel-heading div { display: grid; gap: 0.2rem; }

    /* ─── Cards ──────────────────────────────────── */
    .study-card,
    .edit-panel,
    .empty-state,
    .stats-grid article,
    .timeline-list article,
    .card-list article {
        border: 1px solid var(--glass-border);
        border-radius: var(--radius-lg);
        background: var(--glass-strong);
        box-shadow: var(--shadow-soft);
        backdrop-filter: blur(22px) saturate(1.3);
    }

    .flip-stage {
        min-height: 0;
        perspective: 1200px;
        touch-action: manipulation;
    }

    .flip-stage:focus-visible {
        outline: 2.5px solid rgba(4, 116, 129, 0.4);
        outline-offset: 3px;
        border-radius: var(--radius-lg);
    }

    .study-card.flip-card {
        position: relative;
        height: 100%;
        min-height: 0;
        overflow: hidden;
        padding: 0;
        cursor: pointer;
        transform-style: preserve-3d;
        background: var(--content-bg);
        transition: box-shadow 150ms ease, border-color 150ms ease;
    }

    .flip-stage:hover .flip-card {
        border-color: rgba(255, 255, 255, 0.98);
        box-shadow: var(--shadow-lift);
    }

    .card-face {
        position: absolute;
        inset: 0;
        display: grid;
        grid-template-rows: auto minmax(0, 1fr) auto;
        gap: 0.85rem;
        padding: 1.2rem;
        overflow: hidden;
        border-radius: inherit;
        backface-visibility: hidden;
        -webkit-backface-visibility: hidden;
        transition:
            transform 240ms cubic-bezier(0.2, 0.72, 0.22, 1),
            opacity 160ms ease,
            visibility 0s linear 160ms;
    }

    .card-front {
        background: linear-gradient(148deg, rgba(255,255,255,0.97), rgba(232,250,250,0.82));
        opacity: 1;
        visibility: visible;
        z-index: 2;
        pointer-events: auto;
        transform: rotateY(0deg);
        transition-delay: 0s;
    }

    .card-back {
        background: linear-gradient(148deg, rgba(255,255,255,0.97), rgba(238,252,233,0.85));
        opacity: 0;
        visibility: hidden;
        z-index: 1;
        pointer-events: none;
        transform: rotateY(180deg);
    }

    .flip-stage.flipped .card-front {
        opacity: 0; visibility: hidden; z-index: 1; pointer-events: none;
        transform: rotateY(-180deg);
    }

    .flip-stage.flipped .card-back {
        opacity: 1; visibility: visible; z-index: 2; pointer-events: auto;
        transform: rotateY(0deg);
        transition-delay: 0s;
    }

    .card-meta {
        display: flex;
        justify-content: space-between;
        gap: 0.75rem;
        color: var(--muted-lt);
        font-size: 0.75rem;
        font-weight: 650;
    }

    .card-center {
        display: grid;
        align-content: center;
        justify-items: center;
        min-height: 0;
        padding: 0.8rem 0.4rem;
        text-align: center;
    }

    .card-center .field-label { margin-bottom: 0.7rem; }

    .card-footer {
        display: grid;
        gap: 0.5rem;
        justify-items: center;
        min-height: 2.8rem;
    }

    .tag-row {
        display: flex;
        flex-wrap: wrap;
        justify-content: center;
        gap: 0.4rem;
    }

    .tag-row span {
        border: 1px solid rgba(4, 116, 129, 0.2);
        border-radius: 999px;
        background: rgba(4, 116, 129, 0.06);
        padding: 0.22rem 0.6rem;
        color: var(--teal);
        font-size: 0.76rem;
        font-weight: 700;
    }

    .card-back a,
    .markdown-content :global(a) {
        color: var(--teal);
        font-weight: 700;
        text-decoration: none;
    }

    .markdown-content {
        min-width: 0; max-width: 100%; overflow: auto;
        color: var(--ink-2);
        font-size: calc(1rem * var(--card-font-scale));
        overflow-wrap: anywhere;
        line-height: 1.6;
        white-space: normal;
    }

    .question-content {
        color: var(--ink);
        font-size: clamp(
            calc(2rem * var(--card-font-scale)),
            calc(8vw * var(--card-font-scale)),
            calc(3.8rem * var(--card-font-scale))
        );
        font-weight: 800;
        line-height: 1.08;
        letter-spacing: -0.03em;
    }

    .answer-content {
        font-size: clamp(
            calc(1.35rem * var(--card-font-scale)),
            calc(4.8vw * var(--card-font-scale)),
            calc(2.2rem * var(--card-font-scale))
        );
        font-weight: 600;
        line-height: 1.3;
    }

    .markdown-content :global(p),
    .markdown-content :global(ul),
    .markdown-content :global(ol),
    .markdown-content :global(blockquote),
    .markdown-content :global(pre),
    .card-preview-title :global(p),
    .card-preview-body :global(p) { margin: 0 0 0.65rem; }

    .markdown-content :global(h3),
    .markdown-content :global(h4),
    .markdown-content :global(h5) {
        margin: 0 0 0.6rem; color: var(--ink); line-height: 1.22;
    }

    .markdown-content :global(ul),
    .markdown-content :global(ol) {
        display: grid; gap: 0.3rem; padding-left: 1.2rem;
    }

    .markdown-content :global(code),
    .card-preview-title :global(code),
    .card-preview-body :global(code) {
        border: 1px solid var(--line);
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.7);
        padding: 0.06rem 0.3rem;
        font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
        font-size: 0.9em;
    }

    .markdown-content :global(pre) {
        overflow: auto;
        border: 1px solid var(--line);
        border-radius: var(--radius-sm);
        background: rgba(255, 255, 255, 0.7);
        padding: 0.85rem;
    }

    .markdown-content :global(pre code) { border: 0; background: transparent; padding: 0; white-space: pre; }

    .markdown-content :global(blockquote) {
        border-left: 3px solid var(--teal);
        padding-left: 0.8rem;
        color: #4b5563;
    }

    .tap-hint {
        color: var(--muted-lt);
        font-size: 0.78rem;
        font-weight: 600;
        text-align: center;
        letter-spacing: 0;
    }

    /* ─── Buttons ────────────────────────────────── */
    .primary-action {
        width: 100%;
        min-height: 3.2rem;
        border-color: rgba(255, 255, 255, 0.5);
        border-radius: 999px;
        background: linear-gradient(135deg, var(--teal), #1a9e8f);
        color: #ffffff;
        font-size: 1rem;
        font-weight: 750;
        box-shadow: 0 10px 28px rgba(4, 116, 129, 0.28);
        letter-spacing: -0.01em;
    }

    .primary-action:hover {
        background: linear-gradient(135deg, #0588a0, #1db89e);
        box-shadow: 0 14px 36px rgba(4, 116, 129, 0.34);
        transform: translateY(-1px);
    }

    .primary-action.compact {
        width: auto;
        min-width: 7rem;
        min-height: 2.7rem;
        font-size: 0.92rem;
    }

    /* ─── Rating buttons ─────────────────────────── */
    .rating-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 0.5rem;
        max-width: 48rem;
    }

    .rating {
        display: grid;
        gap: 0.18rem;
        min-height: 4.6rem;
        padding: 0.6rem 0.2rem;
        border: 1px solid rgba(255, 255, 255, 0.45);
        border-radius: var(--radius-md);
        color: #ffffff;
        font-size: 0.92rem;
        font-weight: 750;
        box-shadow: 0 8px 20px rgba(30, 50, 60, 0.14);
        transition: transform 100ms ease, box-shadow 100ms ease;
    }

    .rating:hover {
        transform: translateY(-2px);
        box-shadow: 0 14px 28px rgba(30, 50, 60, 0.2);
    }

    .rating:active { transform: translateY(0) scale(0.97); }

    .rating small { font-size: 0.79rem; font-weight: 600; opacity: 0.9; }

    .rating.again { background: linear-gradient(148deg, #e53e3e, #f56565); }
    .rating.hard  { background: linear-gradient(148deg, #d97706, #f59e0b); }
    .rating.good  { background: linear-gradient(148deg, #059669, #34d399); }
    .rating.easy  { background: linear-gradient(148deg, #2563eb, #60a5fa); }

    /* ─── Forms ──────────────────────────────────── */
    .card-form, .edit-panel { display: grid; gap: 0.9rem; }

    .card-form {
        border: 1px solid var(--glass-border);
        border-radius: var(--radius-lg);
        background: var(--glass-bg);
        padding: 1.1rem;
        box-shadow: var(--shadow-soft);
        backdrop-filter: blur(22px) saturate(1.3);
    }

    .edit-panel { padding: 1rem; }
    .edit-panel-title { color: var(--teal); font-size: 0.78rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em; }

    .button-row { display: flex; gap: 0.55rem; align-items: center; flex-wrap: wrap; }
    .button-row button:not(.primary-action) { min-height: 2.7rem; padding: 0 0.9rem; }

    .search-box {
        border: 1px solid var(--glass-border);
        border-radius: var(--radius-md);
        background: var(--glass-bg);
        padding: 0.75rem 0.9rem;
        box-shadow: var(--shadow-soft);
        backdrop-filter: blur(22px) saturate(1.3);
    }

    /* ─── Card list ──────────────────────────────── */
    .card-list, .timeline-list { display: grid; gap: 0.65rem; }

    .card-list article {
        display: grid;
        gap: 0.7rem;
        padding: 0.9rem 1rem;
    }

    .card-preview-title,
    .timeline-list strong {
        display: block;
        font-size: calc(0.96rem * var(--card-font-scale));
        font-weight: 750;
        line-height: 1.35;
        color: var(--ink);
    }

    .card-preview-body {
        display: -webkit-box;
        margin-top: 0.22rem;
        overflow: hidden;
        color: var(--muted);
        font-size: calc(0.9rem * var(--card-font-scale));
        line-height: 1.5;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
    }

    .card-list small, .timeline-list small {
        display: block;
        margin-top: 0.4rem;
        color: var(--muted-lt);
        font-size: 0.76rem;
    }

    .row-actions { display: flex; gap: 0.4rem; }
    .row-actions button { min-height: 2.5rem; padding: 0 0.8rem; font-size: 0.84rem; font-weight: 700; }
    .danger-link { color: var(--red); }

    .hidden-input { display: none; }

    /* ─── Segmented controls ─────────────────────── */
    .mode-control, .review-controls {
        display: grid;
        padding: 0.2rem;
        border: 1px solid var(--glass-border);
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.45);
        box-shadow: inset 0 1px 2px rgba(255, 255, 255, 0.9);
    }

    .mode-control { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .review-controls { grid-template-columns: repeat(2, minmax(0, 1fr)); max-width: 22rem; }

    .mode-control button, .review-controls button {
        min-height: 2.6rem;
        border: 0;
        background: transparent;
        border-radius: 999px;
        color: var(--muted);
        font-weight: 700;
        letter-spacing: -0.01em;
    }

    .mode-control button.active, .review-controls button.active {
        background: rgba(255, 255, 255, 0.88);
        color: var(--teal-strong);
        box-shadow: 0 4px 14px rgba(30, 50, 60, 0.09);
        font-weight: 750;
    }

    /* ─── File actions ───────────────────────────── */
    .file-actions { display: grid; gap: 0.65rem; }
    .file-actions button {
        display: grid; gap: 0.28rem; justify-items: start;
        min-height: 4.5rem; padding: 0.9rem 1.1rem;
        text-align: left; border-radius: var(--radius-md);
    }
    .file-actions strong { font-size: 1rem; font-weight: 750; }
    .file-actions span { color: var(--muted); font-size: 0.86rem; }

    /* ─── Stats ──────────────────────────────────── */
    .stats-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 0.65rem;
    }

    .stats-grid article {
        display: grid;
        gap: 0.3rem;
        padding: 1rem 1.1rem;
    }

    .stats-grid span {
        color: var(--muted-lt);
        font-size: 0.75rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
    }

    .stats-grid strong {
        color: var(--ink);
        font-size: 2.1rem;
        font-weight: 800;
        line-height: 1;
        letter-spacing: -0.04em;
    }

    .stats-grid strong small {
        font-size: 1rem;
        font-weight: 600;
        letter-spacing: 0;
        color: var(--muted);
    }

    /* ─── Timeline ───────────────────────────────── */
    .timeline-list article {
        display: grid;
        grid-template-columns: 4.5rem 1fr;
        gap: 0.75rem;
        padding: 0.85rem 1rem;
        align-items: start;
    }

    .rating-badge {
        border-radius: 8px;
        padding: 0.3rem 0.4rem;
        text-align: center;
        font-size: 0.75rem;
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: #fff;
    }
    .rating-badge-again { background: var(--red); }
    .rating-badge-hard  { background: var(--amber); }
    .rating-badge-good  { background: var(--green); }
    .rating-badge-easy  { background: var(--blue); }

    /* ─── Account ────────────────────────────────── */
    .account-panel { max-width: 42rem; }

    .account-card {
        display: grid;
        gap: 0.65rem;
        border: 1px solid var(--glass-border);
        border-radius: var(--radius-lg);
        background: var(--glass-strong);
        padding: 1rem 1.1rem;
        box-shadow: var(--shadow-soft);
        backdrop-filter: blur(22px) saturate(1.3);
    }

    .account-card div {
        display: grid;
        gap: 0.22rem;
        min-width: 0;
        border-bottom: 1px solid var(--line);
        padding-bottom: 0.65rem;
    }

    .account-card div:last-child { border-bottom: 0; padding-bottom: 0; }

    .account-card span {
        color: var(--muted-lt);
        font-size: 0.75rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
    }

    .account-card strong { min-width: 0; overflow-wrap: anywhere; color: var(--ink); font-size: 0.96rem; }

    .status-syncing { color: var(--teal); }
    .status-ok { color: var(--green); }

    .account-actions { display: flex; flex-wrap: wrap; gap: 0.65rem; }
    .account-actions button { min-height: 2.9rem; padding: 0 1.1rem; font-weight: 750; }

    .api-key-form {
        display: grid;
        gap: 0.9rem;
        border: 1px solid var(--glass-border);
        border-radius: var(--radius-lg);
        background: var(--glass-strong);
        padding: 1rem 1.1rem;
        box-shadow: var(--shadow-soft);
        backdrop-filter: blur(22px) saturate(1.3);
    }

    .settings-card {
        display: grid;
        gap: 0.9rem;
        border: 1px solid var(--glass-border);
        border-radius: var(--radius-lg);
        background: var(--glass-strong);
        padding: 1rem 1.1rem;
        box-shadow: var(--shadow-soft);
        backdrop-filter: blur(22px) saturate(1.3);
    }

    .settings-card-header { display: flex; align-items: start; justify-content: space-between; gap: 1rem; }
    .settings-card-header h3 { margin: 0.1rem 0 0; font-size: 1rem; }
    .settings-card-header strong { color: var(--teal); font-size: 0.96rem; font-weight: 750; }

    .range-setting {
        display: grid;
        grid-template-columns: 2.8rem minmax(0, 1fr) 2.8rem;
        gap: 0.65rem;
        align-items: center;
    }

    .range-setting button {
        min-height: 2.5rem;
        border-color: rgba(4, 116, 129, 0.2);
        color: var(--teal);
        font-weight: 800;
    }

    .range-setting input[type="range"] {
        appearance: none;
        width: 100%;
        height: 0.65rem;
        border: 1px solid rgba(100, 130, 140, 0.18);
        border-radius: 999px;
        background: linear-gradient(
            90deg,
            var(--teal) 0%,
            var(--teal) var(--range-progress),
            rgba(100, 130, 140, 0.16) var(--range-progress),
            rgba(100, 130, 140, 0.16) 100%
        );
        outline: none;
    }

    .range-setting input[type="range"]::-webkit-slider-thumb {
        appearance: none;
        width: 1.5rem;
        height: 1.5rem;
        border: 2.5px solid #ffffff;
        border-radius: 999px;
        background: var(--teal);
        box-shadow: 0 4px 14px rgba(30, 50, 60, 0.18);
    }

    .range-setting input[type="range"]::-moz-range-thumb {
        width: 1.3rem;
        height: 1.3rem;
        border: 2px solid #ffffff;
        border-radius: 999px;
        background: var(--teal);
        box-shadow: 0 4px 14px rgba(30, 50, 60, 0.18);
    }

    .profile-note { color: var(--muted); font-size: 0.82rem; line-height: 1.5; }

    /* ─── Empty / Misc ───────────────────────────── */
    .empty-state {
        display: grid;
        gap: 0.7rem;
        justify-items: center;
        text-align: center;
        padding: 1.4rem;
        color: var(--muted);
    }

    .empty-icon { font-size: 2.5rem; line-height: 1; }
    .empty-state h3 { color: var(--ink); font-size: 1.15rem; }
    .empty-state p { font-size: 0.9rem; line-height: 1.55; }

    .empty-state button {
        min-height: 2.7rem;
        padding: 0 1rem;
        border-color: rgba(4, 116, 129, 0.28);
        color: var(--teal);
        font-weight: 750;
    }

    .compact-empty { box-shadow: none; }

    .inline-status {
        color: var(--teal-strong);
        font-size: 0.88rem;
        font-weight: 700;
        letter-spacing: 0;
    }

    .review-status {
        position: absolute;
        top: 5.8rem;
        right: 0;
        z-index: 5;
        max-width: min(70%, 24rem);
        text-align: right;
        pointer-events: none;
        font-size: 0.82rem;
    }

    /* ─── AI chat ────────────────────────────────── */
    .ai-chat-shell {
        position: absolute;
        left: 0;
        bottom: 5.2rem;
        z-index: 20;
        display: grid;
        justify-items: start;
        width: min(100%, 30rem);
        max-width: calc(100vw - 1.5rem);
        pointer-events: none;
    }

    .ai-hover-button {
        display: grid;
        place-items: center;
        width: 3.2rem;
        height: 3.2rem;
        min-height: 0;
        border: 1.5px solid rgba(56, 111, 198, 0.28);
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.86);
        color: var(--blue);
        font-size: 0.88rem;
        font-weight: 850;
        box-shadow: var(--shadow-soft);
        backdrop-filter: blur(18px) saturate(1.3);
        pointer-events: auto;
    }

    .ai-hover-button:hover,
    .ai-chat-shell.expanded .ai-hover-button,
    .ai-chat-shell:focus-within .ai-hover-button {
        background: rgba(255, 255, 255, 0.96);
        transform: translateY(-1px);
    }

    .ai-chat {
        display: grid; gap: 0.85rem; width: 100%;
        max-height: 0; margin-top: 0; overflow: hidden;
        border: 1px solid var(--glass-border);
        border-radius: var(--radius-lg);
        background: rgba(255, 255, 255, 0.68);
        padding: 0 0.95rem;
        opacity: 0;
        box-shadow: var(--shadow-soft);
        backdrop-filter: blur(22px) saturate(1.3);
        transform: translateY(-0.3rem) scale(0.98);
        transform-origin: top left;
        pointer-events: none;
        transition: max-height 170ms ease, margin-top 170ms ease, opacity 140ms ease, padding 170ms ease, transform 170ms ease;
    }

    .ai-chat-shell:hover .ai-chat,
    .ai-chat-shell:focus-within .ai-chat,
    .ai-chat-shell.expanded .ai-chat {
        max-height: min(58dvh, 30rem);
        margin-top: 0.7rem;
        padding: 0.95rem;
        opacity: 1;
        pointer-events: auto;
        transform: translateY(0) scale(1);
    }

    .ai-chat-header { display: flex; align-items: start; justify-content: space-between; gap: 0.75rem; }
    .ai-chat-header h3 { margin: 0.1rem 0 0; font-size: 0.98rem; line-height: 1.2; }
    .ai-chat-actions { display: flex; flex-wrap: wrap; gap: 0.4rem; justify-content: end; }

    .ai-thread { display: grid; gap: 0.65rem; max-height: min(32dvh, 16rem); overflow: auto; padding: 0.1rem; }

    .ai-empty {
        margin: 0;
        border: 1px dashed rgba(4, 116, 129, 0.26);
        border-radius: var(--radius-md);
        background: rgba(255, 255, 255, 0.5);
        padding: 0.9rem;
        color: var(--muted);
        font-size: 0.88rem;
        line-height: 1.5;
    }

    .ai-message {
        display: grid;
        gap: 0.3rem;
        max-width: min(100%, 38rem);
        border: 1px solid rgba(100, 130, 140, 0.18);
        border-radius: 20px;
        padding: 0.75rem 0.9rem;
    }

    .ai-message.user { justify-self: end; background: rgba(56, 111, 198, 0.1); }
    .ai-message.model { justify-self: start; background: rgba(255, 255, 255, 0.82); }
    .ai-message > span { color: var(--teal); font-size: 0.7rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.06em; }

    .ai-composer { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0.6rem; align-items: end; }
    .ai-input-shell { position: relative; min-width: 0; }
    .ai-input-shell textarea { width: 100%; min-height: 5rem; padding-left: 3rem; resize: vertical; }

    .ai-plus {
        position: absolute; left: 0.7rem; bottom: 0.7rem;
        display: grid; place-items: center;
        width: 2rem; height: 2rem; min-height: 0;
        border: 1px solid rgba(100, 130, 140, 0.22);
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.85);
        color: var(--teal); font-size: 1.2rem; font-weight: 720; line-height: 1;
        box-shadow: 0 4px 12px rgba(30, 50, 60, 0.07);
    }

    .ai-plus:disabled { cursor: wait; opacity: 0.5; }

    .ai-prompt-menu {
        position: absolute; left: 0.3rem; bottom: 3rem; z-index: 5;
        display: flex; gap: 0.4rem;
        border: 1px solid var(--glass-border);
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.92);
        padding: 0.3rem;
        box-shadow: var(--shadow-soft);
        backdrop-filter: blur(16px) saturate(1.2);
    }

    .ai-prompt-menu button {
        min-height: 2rem; padding: 0 0.75rem;
        border: 0; border-radius: 999px;
        background: rgba(4, 116, 129, 0.07);
        color: var(--teal); font-size: 0.8rem; font-weight: 800;
    }

    .ai-action { min-height: 2.7rem; padding: 0 1rem; border-color: rgba(56, 111, 198, 0.22); color: var(--blue); font-weight: 750; }
    .ai-action:disabled { cursor: wait; opacity: 0.68; transform: none; }

    .ghost-action { min-height: 2.35rem; border-color: rgba(100, 130, 140, 0.2); color: var(--muted); font-weight: 750; }
    .ghost-action.compact { padding: 0 0.85rem; }

    /* ─── Responsive ─────────────────────────────── */
    @media (min-width: 760px) {
        .app-shell {
            height: calc(100dvh - 3rem);
            min-height: 0;
            margin: 1.5rem auto;
            border: 1px solid var(--glass-border);
            border-radius: 32px;
            overflow: hidden;
            box-shadow: var(--shadow-lift);
            backdrop-filter: blur(28px) saturate(1.25);
        }

        .auth-screen {
            grid-column: 1 / -1;
            max-width: 28rem;
            min-height: 44rem;
            margin: 0 auto;
            background: transparent;
        }

        .bottom-tab-bar {
            border-radius: 0 0 32px 32px;
            left: auto;
            right: auto;
            max-width: 72rem;
        }

        .workspace {
            padding: 1.35rem;
            padding-bottom: calc(var(--tab-bar-h) + 0.5rem);
            overflow: hidden;
        }

        .review-panel {
            position: relative;
            grid-template-rows: auto auto minmax(0, 1fr) auto;
            max-width: 48rem;
        }

        .card-form, .edit-panel, .file-actions, .card-list { max-width: 48rem; }

        .stats-grid {
            grid-template-columns: repeat(3, minmax(0, 1fr));
            max-width: 48rem;
        }

        .card-list article {
            grid-template-columns: 1fr auto;
            align-items: start;
        }
    }
</style>
