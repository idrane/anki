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
        type SrsCard,
        type SrsCollection,
    } from "./scheduler";
    import { supabase } from "./supabase";

    type Tab = "review" | "create" | "cards" | "files" | "stats" | "account";
    type ImportKind = "json" | "csv";
    type ImportMode = "merge" | "replace";

    const storageKey = "anki.personal-srs.collection.v1";
    const geminiApiKeyStorageKey = "anki.personal-srs.gemini-api-key.v1";
    const geminiModel = "gemini-3.1-flash-lite";
    const tabs: { id: Tab; label: string }[] = [
        { id: "review", label: "Review" },
        { id: "create", label: "Create" },
        { id: "cards", label: "Cards" },
        { id: "files", label: "Files" },
        { id: "stats", label: "Stats" },
        { id: "account", label: "Account" },
    ];

    let collection: SrsCollection = createEmptyCollection();
    let session: Session | null = null;
    let authReady = false;
    let syncing = false;
    let syncStatus = "";
    let activeTab: Tab = "review";
    let menuOpen = false;
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
    let aiExplanation = "";
    let aiStatus = "";
    let aiLoading = false;
    let aiCardId = "";

    $: due = dueCards(collection.cards);
    $: upcoming = upcomingCards(collection.cards);
    $: currentCard = due[0] ?? null;
    $: ratingPreviews = currentCard
        ? previewsForCard(currentCard, collection.settings)
        : [];
    $: filteredCards = filteredCardList(collection.cards, search);
    $: todayReviews = reviewsToday(collection.reviewLog);
    $: streak = studyStreakDays(collection.reviewLog);
    $: retention = retentionPercent(collection.reviewLog);
    $: matureCards = collection.cards.filter((card) => card.intervalDays >= 21).length;
    $: userId = session?.user.id ?? "";
    $: userEmail = session?.user.email ?? "Google account";
    $: geminiKeySaved = Boolean(geminiApiKey);
    $: if (loaded && session) {
        localStorage.setItem(storageKey, JSON.stringify(collection));
    }
    $: if (currentCard?.id !== aiCardId) {
        aiExplanation = "";
        aiStatus = "";
        aiCardId = currentCard?.id ?? "";
    }

    onMount(() => {
        let unsubscribe: (() => void) | undefined;
        geminiApiKey = localStorage.getItem(geminiApiKeyStorageKey) ?? "";
        geminiApiKeyInput = geminiApiKey;

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
        return () => unsubscribe?.();
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
        aiExplanation = "";
        aiStatus = "Gemini API key removed.";
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

    async function requestAiExplanation(): Promise<void> {
        if (!currentCard) {
            return;
        }
        if (!geminiApiKey) {
            aiStatus = "Save a Gemini API key in Account first.";
            return;
        }

        aiLoading = true;
        aiStatus = "";
        aiExplanation = "";
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
                        contents: [
                            {
                                role: "user",
                                parts: [
                                    {
                                        text: buildAiExplanationPrompt(currentCard),
                                    },
                                ],
                            },
                        ],
                        generationConfig: {
                            temperature: 0.25,
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
                throw new Error("Gemini returned an empty explanation.");
            }
            aiExplanation = text;
            aiStatus = "AI explanation ready.";
        } catch (error) {
            aiStatus =
                error instanceof Error ? error.message : "AI explanation failed.";
        } finally {
            aiLoading = false;
        }
    }

    function buildAiExplanationPrompt(card: SrsCard): string {
        return [
            "You are a concise study tutor for an SRS flashcard app.",
            "Explain the answer in Korean with a compact Markdown structure.",
            "Do not repeat the full flashcard. Add helpful context, distinctions, and one memory cue.",
            "Keep it under 220 Korean words.",
            "",
            `Question:\n${card.front}`,
            "",
            `Answer:\n${card.back}`,
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
        syncing = true;
        try {
            const savedCard = await updateRemoteCard(result.card);
            const savedLog = await insertRemoteReviewLog(result.log, userId);
            collection = {
                ...collection,
                cards: collection.cards.map((card) =>
                    card.id === savedCard.id ? savedCard : card,
                ),
                reviewLog: [savedLog, ...collection.reviewLog],
            };
            showBack = false;
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

    function renderMarkdown(value: string): string {
        const lines = escapeHtml(value).replace(/\r\n?/g, "\n").split("\n");
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
                createCard(row[frontIndex] ?? "", row[backIndex] ?? "", {
                    deck: row[deckIndex] || "Default",
                    tags: splitTags(row[tagsIndex] ?? ""),
                    source: row[sourceIndex] || undefined,
                }),
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

        const front = String(value.front ?? value.question ?? "").trim();
        const back = String(value.back ?? value.answer ?? "").trim();
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

<main class="personal-srs">
    <section class="app-shell" aria-label="Personal spaced repetition app">
        {#if !authReady}
            <section class="auth-screen" aria-label="Loading account">
                <p class="section-label">Account</p>
                <h1>Personal SRS</h1>
                <p>Checking session...</p>
            </section>
        {:else if !session}
            <section class="auth-screen" aria-label="Sign in">
                <p class="section-label">Private Access</p>
                <h1>Personal SRS</h1>
                <p>Sign in with Google to sync cards and reviews to your database.</p>
                <button
                    type="button"
                    class="primary-action"
                    on:click={signInWithGoogle}
                >
                    Continue with Google
                </button>
                {#if syncStatus}
                    <p class="inline-status">{syncStatus}</p>
                {/if}
            </section>
        {:else}
            <div class:open={menuOpen} class="menu-shell">
                <button
                    type="button"
                    class="menu-toggle"
                    aria-label={menuOpen ? "Close menu" : "Open menu"}
                    aria-expanded={menuOpen}
                    aria-controls="tab-menu"
                    on:click={toggleMenu}
                    on:mouseenter={() => (menuOpen = true)}
                >
                    <span></span>
                    <span></span>
                    <span></span>
                </button>

                {#if menuOpen}
                    <nav
                        id="tab-menu"
                        class="tab-rail"
                        aria-label="Personal SRS tabs"
                        on:mouseleave={() => (menuOpen = false)}
                    >
                        {#each tabs as tab}
                            <button
                                type="button"
                                class:active={activeTab === tab.id}
                                aria-current={activeTab === tab.id ? "page" : undefined}
                                on:click={() => switchTab(tab.id)}
                            >
                                <TabIcon name={tab.id} />
                                <span>{tab.label}</span>
                            </button>
                        {/each}
                    </nav>
                {/if}
            </div>

            <section class="workspace">
                {#if activeTab === "review"}
                    <section
                        class="tab-panel review-panel"
                        aria-labelledby="review-title"
                    >
                        <div class="panel-heading">
                            <div>
                                <p class="section-label">Memorize</p>
                                <h2 id="review-title">Review queue</h2>
                            </div>
                            <span class="status-pill">{due.length} due</span>
                        </div>

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
                                        <p class="field-label">Front</p>
                                        <div class="markdown-content question-content">
                                            {@html renderMarkdown(currentCard.front)}
                                        </div>
                                        {#if currentCard.tags.length}
                                            <div class="tag-row">
                                                {#each currentCard.tags as tag}
                                                    <span>{tag}</span>
                                                {/each}
                                            </div>
                                        {/if}
                                        <p class="tap-hint">Tap to reveal answer</p>
                                    </section>

                                    <section class="card-face card-back">
                                        <div class="card-meta">
                                            <span>{currentCard.deck}</span>
                                            <span>{currentCard.phase}</span>
                                        </div>
                                        <p class="field-label">Back</p>
                                        <div class="markdown-content answer-content">
                                            {@html renderMarkdown(currentCard.back)}
                                        </div>
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
                                        <p class="tap-hint">Tap to see question</p>
                                    </section>
                                </article>
                            </div>

                            {#if showBack}
                                <div class="ai-tools">
                                    <button
                                        type="button"
                                        class="ai-action"
                                        disabled={aiLoading}
                                        on:click={requestAiExplanation}
                                    >
                                        {aiLoading
                                            ? "Asking Gemini..."
                                            : "AI explanation"}
                                    </button>
                                    {#if aiStatus}
                                        <p class="inline-status">{aiStatus}</p>
                                    {/if}
                                </div>
                                {#if aiExplanation}
                                    <article class="ai-explanation">
                                        <p class="field-label">Gemini note</p>
                                        <div class="markdown-content">
                                            {@html renderMarkdown(aiExplanation)}
                                        </div>
                                    </article>
                                {/if}
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
                            {:else}
                                <p class="inline-status">Tap the card to flip it.</p>
                            {/if}
                        {:else}
                            <div class="empty-state">
                                <h3>Review complete</h3>
                                {#if upcoming[0]}
                                    <p>Next card is {nextDueLabel(upcoming[0])}.</p>
                                {:else}
                                    <p>No cards are waiting.</p>
                                {/if}
                                <button
                                    type="button"
                                    on:click={() => switchTab("create")}
                                >
                                    Create card
                                </button>
                            </div>
                        {/if}
                    </section>
                {:else if activeTab === "create"}
                    <section class="tab-panel" aria-labelledby="create-title">
                        <div class="panel-heading">
                            <div>
                                <p class="section-label">Create</p>
                                <h2 id="create-title">New card</h2>
                            </div>
                        </div>

                        <form class="card-form" on:submit|preventDefault={addCard}>
                            <label>
                                <span>Deck</span>
                                <input bind:value={createDeck} autocomplete="off" />
                            </label>
                            <label>
                                <span>Front</span>
                                <textarea bind:value={createFront} rows="5"></textarea>
                            </label>
                            <label>
                                <span>Back</span>
                                <textarea bind:value={createBack} rows="5"></textarea>
                            </label>
                            <label>
                                <span>Tags</span>
                                <input
                                    bind:value={createTags}
                                    placeholder="biology, exam"
                                    autocomplete="off"
                                />
                            </label>
                            <label>
                                <span>Source</span>
                                <input
                                    bind:value={createSource}
                                    placeholder="https://..."
                                    autocomplete="off"
                                />
                            </label>
                            <button type="submit" class="primary-action">
                                Save card
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
                                <p class="section-label">Manage</p>
                                <h2 id="cards-title">Cards</h2>
                            </div>
                            <span class="status-pill">
                                {collection.cards.length} total
                            </span>
                        </div>

                        <label class="search-box">
                            <span>Search</span>
                            <input bind:value={search} autocomplete="off" />
                        </label>

                        {#if editingId}
                            <form
                                class="edit-panel"
                                on:submit|preventDefault={saveEdit}
                            >
                                <label>
                                    <span>Deck</span>
                                    <input bind:value={editDeck} autocomplete="off" />
                                </label>
                                <label>
                                    <span>Front</span>
                                    <textarea
                                        bind:value={editFront}
                                        rows="4"
                                    ></textarea>
                                </label>
                                <label>
                                    <span>Back</span>
                                    <textarea bind:value={editBack} rows="4"></textarea>
                                </label>
                                <label>
                                    <span>Tags</span>
                                    <input bind:value={editTags} autocomplete="off" />
                                </label>
                                <label>
                                    <span>Source</span>
                                    <input bind:value={editSource} autocomplete="off" />
                                </label>
                                <div class="button-row">
                                    <button
                                        type="submit"
                                        class="primary-action compact"
                                    >
                                        Save
                                    </button>
                                    <button
                                        type="button"
                                        on:click={() => (editingId = null)}
                                    >
                                        Cancel
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
                                            {card.deck} - {card.phase} - {nextDueLabel(
                                                card,
                                            )}
                                        </small>
                                    </div>
                                    <div class="row-actions">
                                        <button
                                            type="button"
                                            on:click={() => startEditing(card)}
                                        >
                                            Edit
                                        </button>
                                        <button
                                            type="button"
                                            class="danger-link"
                                            on:click={() => deleteCard(card.id)}
                                        >
                                            Delete
                                        </button>
                                    </div>
                                </article>
                            {:else}
                                <div class="empty-state compact-empty">
                                    <h3>No cards found</h3>
                                    <button
                                        type="button"
                                        on:click={() => switchTab("create")}
                                    >
                                        Create card
                                    </button>
                                </div>
                            {/each}
                        </div>
                    </section>
                {:else if activeTab === "files"}
                    <section class="tab-panel" aria-labelledby="files-title">
                        <div class="panel-heading">
                            <div>
                                <p class="section-label">Files</p>
                                <h2 id="files-title">Import / Export</h2>
                            </div>
                        </div>

                        <input
                            bind:this={fileInput}
                            class="hidden-input"
                            type="file"
                            on:change={importFile}
                        />

                        <div class="mode-control" role="group" aria-label="Import mode">
                            <button
                                type="button"
                                class:active={importMode === "merge"}
                                on:click={() => (importMode = "merge")}
                            >
                                Merge
                            </button>
                            <button
                                type="button"
                                class:active={importMode === "replace"}
                                on:click={() => (importMode = "replace")}
                            >
                                Replace
                            </button>
                        </div>

                        <div class="file-actions">
                            <button type="button" on:click={() => chooseFile("json")}>
                                <strong>Import JSON</strong>
                                <span>Collection JSON or card array</span>
                            </button>
                            <button type="button" on:click={() => chooseFile("csv")}>
                                <strong>Import CSV</strong>
                                <span>front, back, deck, tags, source</span>
                            </button>
                            <button type="button" on:click={exportJson}>
                                <strong>Export JSON</strong>
                                <span>
                                    {collection.cards.length} cards and {collection
                                        .reviewLog.length} reviews
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
                                <p class="section-label">Stats</p>
                                <h2 id="stats-title">Progress</h2>
                            </div>
                        </div>

                        <div class="stats-grid">
                            <article>
                                <span>Due</span>
                                <strong>{due.length}</strong>
                            </article>
                            <article>
                                <span>Reviewed today</span>
                                <strong>{todayReviews}</strong>
                            </article>
                            <article>
                                <span>Streak</span>
                                <strong>{streak}</strong>
                            </article>
                            <article>
                                <span>Retention</span>
                                <strong>{retention}%</strong>
                            </article>
                            <article>
                                <span>Mature</span>
                                <strong>{matureCards}</strong>
                            </article>
                            <article>
                                <span>Total</span>
                                <strong>{collection.cards.length}</strong>
                            </article>
                        </div>

                        <div class="timeline-list">
                            {#each collection.reviewLog.slice(0, 8) as entry}
                                <article>
                                    <span>{entry.rating}</span>
                                    <div>
                                        <strong>
                                            {collection.cards.find(
                                                (card) => card.id === entry.cardId,
                                            )?.front ?? "Deleted card"}
                                        </strong>
                                        <small>
                                            {formatDateTime(entry.reviewedAt)} - {entry.nextIntervalDays}d
                                        </small>
                                    </div>
                                </article>
                            {:else}
                                <div class="empty-state compact-empty">
                                    <h3>No reviews yet</h3>
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
                                <p class="section-label">Account</p>
                                <h2 id="account-title">Sync account</h2>
                            </div>
                        </div>

                        <div class="account-card">
                            <div>
                                <span>Signed in</span>
                                <strong>{userEmail}</strong>
                            </div>
                            <div>
                                <span>Status</span>
                                <strong>
                                    {syncing ? "Syncing..." : syncStatus || "Ready"}
                                </strong>
                            </div>
                            <div>
                                <span>Remote cards</span>
                                <strong>{collection.cards.length}</strong>
                            </div>
                            <div>
                                <span>AI model</span>
                                <strong>{geminiModel}</strong>
                            </div>
                            <div>
                                <span>Gemini API key</span>
                                <strong>
                                    {geminiKeySaved ? "Saved" : "Not saved"}
                                </strong>
                            </div>
                        </div>

                        <form
                            class="api-key-form"
                            on:submit|preventDefault={saveGeminiApiKey}
                        >
                            <label>
                                <span>Gemini API key</span>
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
                                    Save key
                                </button>
                                <button type="button" on:click={clearGeminiApiKey}>
                                    Remove key
                                </button>
                            </div>
                            <p class="profile-note">
                                Stored in this browser profile and used only when you
                                request an AI explanation.
                            </p>
                        </form>

                        <div class="account-actions">
                            <button
                                type="button"
                                class="primary-action compact"
                                on:click={() => refreshRemoteCollection()}
                            >
                                Sync now
                            </button>
                            <button
                                type="button"
                                class="danger-link"
                                on:click={signOut}
                            >
                                Sign out
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
    }

    :global(*) {
        box-sizing: border-box;
    }

    .personal-srs {
        --glass-bg: rgba(255, 255, 255, 0.58);
        --glass-strong: rgba(255, 255, 255, 0.78);
        --glass-border: rgba(255, 255, 255, 0.78);
        --content-bg: rgba(255, 255, 255, 0.86);
        --ink: #111827;
        --muted: #5c6670;
        --line: rgba(125, 149, 153, 0.24);
        --teal: #047481;
        --teal-strong: #006b78;
        --green: #2f8f58;
        --blue: #386fc6;
        --amber: #c98616;
        --red: #cf3d38;
        --shadow-soft: 0 14px 38px rgba(42, 58, 68, 0.1);
        --shadow-lift: 0 22px 58px rgba(42, 58, 68, 0.16);
        --radius-lg: 28px;
        --radius-md: 20px;
        --radius-sm: 14px;
        min-height: 100vh;
        color: var(--ink);
        font-family:
            Inter,
            ui-sans-serif,
            system-ui,
            -apple-system,
            BlinkMacSystemFont,
            "Segoe UI",
            sans-serif;
        letter-spacing: 0;
    }

    .app-shell {
        display: grid;
        grid-template-rows: 1fr;
        min-height: 100vh;
        max-width: 72rem;
        margin: 0 auto;
        background: rgba(255, 255, 255, 0.18);
    }

    .auth-screen {
        display: grid;
        align-content: center;
        gap: 1rem;
        min-height: 100vh;
        padding: 1.25rem;
        background: transparent;
    }

    .auth-screen p:not(.section-label):not(.inline-status) {
        color: var(--muted);
        line-height: 1.5;
    }

    h1,
    h2,
    h3,
    p {
        margin: 0;
    }

    h1 {
        font-size: 1.45rem;
        font-weight: 760;
        line-height: 1.1;
    }

    h2 {
        font-size: 1.35rem;
        font-weight: 720;
        line-height: 1.2;
    }

    h3 {
        font-size: 1.42rem;
        font-weight: 720;
        line-height: 1.28;
    }

    button,
    input,
    textarea {
        font: inherit;
        letter-spacing: 0;
    }

    button {
        border: 1px solid var(--line);
        border-radius: var(--radius-sm);
        background: rgba(255, 255, 255, 0.68);
        color: var(--ink);
        cursor: pointer;
        backdrop-filter: blur(18px) saturate(1.25);
        transition:
            transform 130ms ease,
            border-color 130ms ease,
            background 130ms ease,
            box-shadow 130ms ease;
    }

    button:hover {
        border-color: rgba(4, 116, 129, 0.28);
        background: rgba(255, 255, 255, 0.84);
        box-shadow: 0 10px 24px rgba(42, 58, 68, 0.1);
        transform: translateY(-1px);
    }

    button:active {
        transform: translateY(0);
    }

    button:focus-visible,
    input:focus-visible,
    textarea:focus-visible {
        outline: 3px solid rgba(4, 116, 129, 0.24);
        outline-offset: 2px;
    }

    input,
    textarea {
        width: 100%;
        border: 1px solid var(--line);
        border-radius: var(--radius-sm);
        background: rgba(255, 255, 255, 0.68);
        color: var(--ink);
        padding: 0.72rem 0.8rem;
        line-height: 1.4;
        resize: vertical;
    }

    textarea {
        min-height: 8rem;
        white-space: pre-wrap;
    }

    label {
        display: grid;
        gap: 0.35rem;
        color: var(--muted);
        font-size: 0.8rem;
        font-weight: 700;
    }

    label span {
        text-transform: uppercase;
    }

    .section-label,
    .field-label {
        color: var(--teal);
        font-size: 0.76rem;
        font-weight: 800;
        letter-spacing: 0;
        text-transform: uppercase;
    }

    .status-pill {
        border: 1px solid var(--line);
        border-radius: 999px;
        background: var(--glass-strong);
        padding: 0.42rem 0.68rem;
        color: var(--muted);
        font-size: 0.78rem;
        line-height: 1;
        white-space: nowrap;
    }

    .menu-shell {
        position: fixed;
        z-index: 10;
        top: 0.9rem;
        left: 50%;
        display: grid;
        justify-items: center;
        gap: 0.45rem;
        transform: translateX(-50%);
    }

    .menu-toggle {
        display: grid;
        place-items: center;
        gap: 0.18rem;
        width: 2.9rem;
        height: 2.9rem;
        border: 1px solid var(--glass-border);
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.66);
        box-shadow: 0 14px 34px rgba(42, 58, 68, 0.16);
        backdrop-filter: blur(26px) saturate(1.55);
    }

    .menu-toggle span {
        display: block;
        width: 1rem;
        height: 0.12rem;
        border-radius: 999px;
        background: var(--teal-strong);
        transition:
            transform 160ms ease,
            opacity 120ms ease;
    }

    .menu-shell.open .menu-toggle span:nth-child(1) {
        transform: translateY(0.3rem) rotate(45deg);
    }

    .menu-shell.open .menu-toggle span:nth-child(2) {
        opacity: 0;
    }

    .menu-shell.open .menu-toggle span:nth-child(3) {
        transform: translateY(-0.3rem) rotate(-45deg);
    }

    .tab-rail {
        display: grid;
        grid-template-columns: repeat(3, minmax(6.4rem, 1fr));
        gap: 0.32rem;
        width: min(calc(100vw - 1.4rem), 23rem);
        padding: 0.42rem;
        border: 1px solid var(--glass-border);
        border-radius: 24px;
        background: rgba(255, 255, 255, 0.7);
        box-shadow: 0 18px 46px rgba(42, 58, 68, 0.18);
        backdrop-filter: blur(26px) saturate(1.55);
    }

    .tab-rail button {
        display: grid;
        grid-template-columns: auto 1fr;
        justify-items: center;
        align-items: center;
        gap: 0.42rem;
        min-width: 0;
        min-height: 2.7rem;
        padding: 0 0.68rem;
        border: 0;
        border-radius: 999px;
        background: transparent;
        color: var(--muted);
        font-size: 0.8rem;
        font-weight: 720;
    }

    .tab-rail button.active {
        color: var(--teal-strong);
        background: rgba(255, 255, 255, 0.84);
        box-shadow:
            inset 0 0 0 1px rgba(255, 255, 255, 0.8),
            0 8px 20px rgba(42, 58, 68, 0.12);
    }

    .workspace {
        padding: 1rem 0.82rem 1.2rem;
    }

    .tab-panel {
        display: grid;
        gap: 0.9rem;
    }

    .panel-heading {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        max-width: 48rem;
    }

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
        backdrop-filter: blur(24px) saturate(1.35);
    }

    .flip-stage {
        perspective: 1200px;
        touch-action: manipulation;
    }

    .flip-stage:focus-visible {
        outline: 3px solid rgba(4, 116, 129, 0.24);
        outline-offset: 3px;
        border-radius: var(--radius-lg);
    }

    .study-card.flip-card {
        position: relative;
        min-height: clamp(23rem, 58vh, 35rem);
        overflow: hidden;
        padding: 0;
        cursor: pointer;
        transform-style: preserve-3d;
        background: var(--content-bg);
        transition:
            box-shadow 160ms ease,
            border-color 160ms ease;
    }

    .flip-stage:hover .flip-card {
        border-color: rgba(255, 255, 255, 0.96);
        box-shadow: var(--shadow-lift);
    }

    .card-face {
        position: absolute;
        inset: 0;
        display: grid;
        grid-template-rows: auto auto minmax(0, 1fr) auto;
        gap: 1rem;
        padding: 1.18rem;
        overflow: hidden;
        border-radius: inherit;
        backface-visibility: hidden;
        -webkit-backface-visibility: hidden;
        transition:
            transform 260ms cubic-bezier(0.2, 0.72, 0.22, 1),
            opacity 180ms ease,
            visibility 0s linear 180ms;
    }

    .card-front {
        background:
            linear-gradient(
                145deg,
                rgba(255, 255, 255, 0.96),
                rgba(236, 250, 250, 0.78)
            ),
            var(--content-bg);
        opacity: 1;
        visibility: visible;
        z-index: 2;
        pointer-events: auto;
        transform: rotateY(0deg);
        transition-delay: 0s;
    }

    .card-back {
        background:
            linear-gradient(
                145deg,
                rgba(255, 255, 255, 0.96),
                rgba(242, 249, 239, 0.82)
            ),
            var(--content-bg);
        opacity: 0;
        visibility: hidden;
        z-index: 1;
        pointer-events: none;
        transform: rotateY(180deg);
    }

    .flip-stage.flipped .card-front {
        opacity: 0;
        visibility: hidden;
        z-index: 1;
        pointer-events: none;
        transform: rotateY(-180deg);
    }

    .flip-stage.flipped .card-back {
        opacity: 1;
        visibility: visible;
        z-index: 2;
        pointer-events: auto;
        transform: rotateY(0deg);
        transition-delay: 0s;
    }

    .card-meta {
        display: flex;
        justify-content: space-between;
        gap: 0.75rem;
        color: var(--muted);
        font-size: 0.82rem;
        font-weight: 700;
    }

    .tag-row {
        display: flex;
        flex-wrap: wrap;
        gap: 0.45rem;
        align-self: end;
    }

    .tag-row span {
        border: 1px solid rgba(4, 116, 129, 0.22);
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.62);
        padding: 0.24rem 0.58rem;
        color: var(--teal);
        font-size: 0.78rem;
        font-weight: 700;
    }

    .card-back a,
    .markdown-content :global(a) {
        color: var(--teal);
        font-weight: 700;
        text-decoration: none;
    }

    .markdown-content {
        min-width: 0;
        overflow: auto;
        color: #1f2937;
        overflow-wrap: anywhere;
        line-height: 1.58;
        white-space: normal;
    }

    .question-content {
        color: #111827;
        font-size: clamp(1.1rem, 1.8vw, 1.36rem);
        font-weight: 660;
        line-height: 1.45;
    }

    .answer-content {
        font-size: clamp(1rem, 1.2vw, 1.1rem);
    }

    .markdown-content :global(p),
    .markdown-content :global(ul),
    .markdown-content :global(ol),
    .markdown-content :global(blockquote),
    .markdown-content :global(pre),
    .card-preview-title :global(p),
    .card-preview-body :global(p) {
        margin: 0 0 0.72rem;
    }

    .markdown-content :global(h3),
    .markdown-content :global(h4),
    .markdown-content :global(h5) {
        margin: 0 0 0.65rem;
        color: #0f172a;
        line-height: 1.22;
    }

    .markdown-content :global(ul),
    .markdown-content :global(ol) {
        display: grid;
        gap: 0.34rem;
        padding-left: 1.25rem;
    }

    .markdown-content :global(code),
    .card-preview-title :global(code),
    .card-preview-body :global(code) {
        border: 1px solid var(--line);
        border-radius: 10px;
        background: rgba(255, 255, 255, 0.64);
        padding: 0.08rem 0.32rem;
        font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
        font-size: 0.92em;
    }

    .markdown-content :global(pre) {
        overflow: auto;
        border: 1px solid var(--line);
        border-radius: var(--radius-sm);
        background: rgba(255, 255, 255, 0.64);
        padding: 0.85rem;
    }

    .markdown-content :global(pre code) {
        border: 0;
        background: transparent;
        padding: 0;
        white-space: pre;
    }

    .markdown-content :global(blockquote) {
        border-left: 3px solid var(--teal);
        padding-left: 0.8rem;
        color: #4b5563;
    }

    .tap-hint {
        align-self: end;
        color: var(--muted);
        font-size: 0.82rem;
        font-weight: 700;
    }

    .primary-action {
        width: 100%;
        min-height: 3rem;
        border-color: rgba(255, 255, 255, 0.44);
        border-radius: 999px;
        background: linear-gradient(135deg, var(--teal), #2f8f8b);
        color: #ffffff;
        font-weight: 760;
        box-shadow: 0 14px 32px rgba(4, 116, 129, 0.24);
    }

    .primary-action.compact {
        width: auto;
        min-width: 7rem;
        min-height: 2.6rem;
    }

    .rating-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 0.55rem;
        max-width: 48rem;
    }

    .ai-tools {
        display: flex;
        flex-wrap: wrap;
        gap: 0.65rem;
        align-items: center;
        max-width: 48rem;
    }

    .ai-action {
        min-height: 2.7rem;
        padding: 0 1rem;
        border-color: rgba(56, 111, 198, 0.22);
        color: var(--blue);
        font-weight: 760;
    }

    .ai-action:disabled {
        cursor: wait;
        opacity: 0.72;
        transform: none;
    }

    .ai-explanation {
        display: grid;
        gap: 0.7rem;
        max-width: 48rem;
        border: 1px solid var(--glass-border);
        border-radius: var(--radius-lg);
        background: var(--glass-strong);
        padding: 1rem;
        box-shadow: var(--shadow-soft);
        backdrop-filter: blur(24px) saturate(1.35);
    }

    .rating {
        display: grid;
        gap: 0.2rem;
        min-height: 4.2rem;
        padding: 0.5rem 0.2rem;
        border: 1px solid rgba(255, 255, 255, 0.42);
        border-radius: var(--radius-md);
        color: #ffffff;
        font-weight: 760;
        box-shadow: 0 12px 26px rgba(42, 58, 68, 0.12);
    }

    .rating:hover {
        transform: translateY(-2px);
    }

    .rating small {
        font-size: 0.82rem;
        font-weight: 640;
    }

    .rating.again {
        background: linear-gradient(145deg, var(--red), #e85d57);
    }

    .rating.hard {
        background: linear-gradient(145deg, var(--amber), #e5a93d);
    }

    .rating.good {
        background: linear-gradient(145deg, var(--green), #4fa96d);
    }

    .rating.easy {
        background: linear-gradient(145deg, var(--blue), #5a8adb);
    }

    .card-form,
    .edit-panel {
        display: grid;
        gap: 0.85rem;
    }

    .card-form {
        border: 1px solid var(--glass-border);
        border-radius: var(--radius-lg);
        background: var(--glass-bg);
        padding: 1rem;
        box-shadow: var(--shadow-soft);
        backdrop-filter: blur(24px) saturate(1.35);
    }

    .edit-panel {
        padding: 1rem;
    }

    .button-row {
        display: flex;
        gap: 0.55rem;
        align-items: center;
        flex-wrap: wrap;
    }

    .button-row button:not(.primary-action) {
        min-height: 2.6rem;
        padding: 0 0.9rem;
    }

    .search-box {
        border: 1px solid var(--glass-border);
        border-radius: var(--radius-md);
        background: var(--glass-bg);
        padding: 0.85rem;
        box-shadow: var(--shadow-soft);
        backdrop-filter: blur(24px) saturate(1.35);
    }

    .card-list,
    .timeline-list {
        display: grid;
        gap: 0.7rem;
    }

    .card-list article {
        display: grid;
        gap: 0.75rem;
        padding: 0.9rem;
    }

    .card-preview-title,
    .timeline-list strong {
        display: block;
        font-size: 0.98rem;
        font-weight: 760;
        line-height: 1.3;
    }

    .card-preview-body {
        display: -webkit-box;
        margin-top: 0.25rem;
        overflow: hidden;
        color: var(--muted);
        line-height: 1.45;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 3;
    }

    .card-list small,
    .timeline-list small {
        display: block;
        margin-top: 0.45rem;
        color: var(--muted);
        font-size: 0.78rem;
    }

    .row-actions {
        display: flex;
        gap: 0.45rem;
    }

    .row-actions button {
        min-height: 2.35rem;
        padding: 0 0.75rem;
        font-size: 0.85rem;
        font-weight: 700;
    }

    .danger-link {
        color: #b42318;
    }

    .hidden-input {
        display: none;
    }

    .mode-control {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        padding: 0.22rem;
        border: 1px solid var(--glass-border);
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.42);
        box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.82);
    }

    .mode-control button {
        min-height: 2.5rem;
        border: 0;
        background: transparent;
        border-radius: 999px;
        color: var(--muted);
        font-weight: 760;
    }

    .mode-control button.active {
        background: rgba(255, 255, 255, 0.82);
        color: var(--teal);
        box-shadow: 0 8px 20px rgba(42, 58, 68, 0.1);
    }

    .file-actions {
        display: grid;
        gap: 0.7rem;
    }

    .file-actions button {
        display: grid;
        gap: 0.3rem;
        justify-items: start;
        min-height: 4.4rem;
        padding: 0.85rem 1rem;
        text-align: left;
        border-radius: var(--radius-md);
    }

    .file-actions strong {
        font-size: 1rem;
    }

    .file-actions span {
        color: var(--muted);
        font-size: 0.88rem;
    }

    .stats-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 0.7rem;
    }

    .stats-grid article {
        display: grid;
        gap: 0.35rem;
        padding: 1rem;
    }

    .account-panel {
        max-width: 42rem;
    }

    .account-card {
        display: grid;
        gap: 0.7rem;
        border: 1px solid var(--glass-border);
        border-radius: var(--radius-lg);
        background: var(--glass-strong);
        padding: 1rem;
        box-shadow: var(--shadow-soft);
        backdrop-filter: blur(24px) saturate(1.35);
    }

    .account-card div {
        display: grid;
        gap: 0.25rem;
        min-width: 0;
        border-bottom: 1px solid var(--line);
        padding-bottom: 0.7rem;
    }

    .account-card div:last-child {
        border-bottom: 0;
        padding-bottom: 0;
    }

    .account-card span {
        color: var(--muted);
        font-size: 0.78rem;
        font-weight: 760;
        text-transform: uppercase;
    }

    .account-card strong {
        min-width: 0;
        overflow-wrap: anywhere;
        color: var(--ink);
        font-size: 1rem;
    }

    .account-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 0.65rem;
    }

    .api-key-form {
        display: grid;
        gap: 0.85rem;
        border: 1px solid var(--glass-border);
        border-radius: var(--radius-lg);
        background: var(--glass-strong);
        padding: 1rem;
        box-shadow: var(--shadow-soft);
        backdrop-filter: blur(24px) saturate(1.35);
    }

    .profile-note {
        color: var(--muted);
        font-size: 0.84rem;
        line-height: 1.45;
    }

    .account-actions button {
        min-height: 2.8rem;
        padding: 0 1rem;
        font-weight: 760;
    }

    .stats-grid span {
        color: var(--muted);
        font-size: 0.78rem;
        font-weight: 760;
        text-transform: uppercase;
    }

    .stats-grid strong {
        color: var(--ink);
        font-size: 2rem;
        line-height: 1;
    }

    .timeline-list article {
        display: grid;
        grid-template-columns: 4.3rem 1fr;
        gap: 0.7rem;
        padding: 0.85rem;
        align-items: start;
    }

    .timeline-list article > span {
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.7);
        color: var(--teal);
        padding: 0.3rem 0.45rem;
        text-align: center;
        font-size: 0.78rem;
        font-weight: 800;
    }

    .empty-state {
        display: grid;
        gap: 0.65rem;
        justify-items: start;
        padding: 1.2rem;
        color: var(--muted);
    }

    .empty-state h3 {
        color: var(--ink);
    }

    .empty-state button {
        min-height: 2.6rem;
        padding: 0 0.9rem;
        border-color: rgba(4, 116, 129, 0.28);
        color: var(--teal);
        font-weight: 760;
    }

    .compact-empty {
        box-shadow: none;
    }

    .inline-status {
        color: var(--teal);
        font-size: 0.88rem;
        font-weight: 700;
    }

    @media (min-width: 760px) {
        .app-shell {
            grid-template-columns: 1fr;
            grid-template-rows: 1fr;
            min-height: min(100vh, 58rem);
            margin: 2rem auto;
            border: 1px solid var(--glass-border);
            border-radius: 34px;
            overflow: hidden;
            box-shadow: var(--shadow-lift);
            backdrop-filter: blur(28px) saturate(1.28);
        }

        .auth-screen {
            grid-column: 1 / -1;
            max-width: 28rem;
            min-height: 40rem;
            margin: 0 auto;
            background: transparent;
        }

        .menu-shell {
            top: calc(2rem + 0.8rem);
        }

        .tab-rail button {
            min-height: 2.8rem;
            font-size: 0.88rem;
            text-align: left;
        }

        .tab-rail button.active {
            box-shadow:
                inset 0 0 0 1px rgba(255, 255, 255, 0.82),
                0 12px 28px rgba(42, 58, 68, 0.1);
            background: rgba(255, 255, 255, 0.76);
        }

        .workspace {
            grid-column: 1;
            grid-row: 1;
            padding: 1.35rem;
            overflow: auto;
        }

        .review-panel {
            max-width: 48rem;
        }

        .card-form,
        .edit-panel,
        .file-actions,
        .card-list {
            max-width: 48rem;
        }

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
