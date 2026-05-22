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

    type Tab = "review" | "create" | "cards" | "files" | "stats";
    type ImportKind = "json" | "csv";
    type ImportMode = "merge" | "replace";

    const storageKey = "anki.personal-srs.collection.v1";
    const tabs: { id: Tab; label: string }[] = [
        { id: "review", label: "Review" },
        { id: "create", label: "Create" },
        { id: "cards", label: "Cards" },
        { id: "files", label: "Files" },
        { id: "stats", label: "Stats" },
    ];

    let collection: SrsCollection = createEmptyCollection();
    let session: Session | null = null;
    let authReady = false;
    let syncing = false;
    let syncStatus = "";
    let activeTab: Tab = "review";
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
    $: if (loaded && session) {
        localStorage.setItem(storageKey, JSON.stringify(collection));
    }

    onMount(() => {
        let unsubscribe: (() => void) | undefined;

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
        showBack = false;
        createStatus = "";
        fileStatus = "";
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
            <header class="top-bar">
                <div>
                    <p class="section-label">
                        {tabs.find((tab) => tab.id === activeTab)?.label}
                    </p>
                    <h1>Personal SRS</h1>
                </div>
                <div class="account-box">
                    <span>{userEmail}</span>
                    <button type="button" on:click={signOut}>Sign out</button>
                </div>
            </header>

            <nav class="tab-rail" aria-label="Personal SRS tabs">
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

            <section class="workspace">
                {#if syncing || syncStatus}
                    <p class="sync-line">
                        {syncing ? "Syncing..." : syncStatus}
                    </p>
                {/if}
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
                            <article class="study-card">
                                <div class="card-meta">
                                    <span>{currentCard.deck}</span>
                                    <span>{currentCard.reps} reps</span>
                                </div>
                                <p class="field-label">Front</p>
                                <h3>{currentCard.front}</h3>
                                {#if currentCard.tags.length}
                                    <div class="tag-row">
                                        {#each currentCard.tags as tag}
                                            <span>{tag}</span>
                                        {/each}
                                    </div>
                                {/if}
                            </article>

                            {#if showBack}
                                <article class="answer-card">
                                    <p class="field-label">Back</p>
                                    <p>{currentCard.back}</p>
                                    {#if currentCard.source}
                                        <a
                                            href={currentCard.source}
                                            target="_blank"
                                            rel="noreferrer"
                                        >
                                            Source
                                        </a>
                                    {/if}
                                </article>

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
                                <button
                                    type="button"
                                    class="primary-action"
                                    on:click={() => (showBack = true)}
                                >
                                    Show answer
                                </button>
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
                                        <strong>{card.front}</strong>
                                        <p>{card.back}</p>
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
                {:else}
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
                {/if}
            </section>
        {/if}
    </section>
</main>

<style>
    :global(body) {
        background: #f6f8f9;
    }

    .personal-srs {
        min-height: 100vh;
        color: #111827;
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
        grid-template-rows: auto 1fr auto;
        min-height: 100vh;
        max-width: 72rem;
        margin: 0 auto;
        background: #f9fbfc;
    }

    .top-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        padding: 1.25rem 1rem 0.75rem;
        border-bottom: 1px solid #d8e0e4;
        background: rgba(249, 251, 252, 0.96);
    }

    .auth-screen {
        display: grid;
        align-content: center;
        gap: 1rem;
        min-height: 100vh;
        padding: 1.25rem;
        background: #ffffff;
    }

    .auth-screen p:not(.section-label):not(.inline-status) {
        color: #4b5563;
        line-height: 1.5;
    }

    .account-box {
        display: grid;
        justify-items: end;
        gap: 0.35rem;
        min-width: 0;
        color: #53606a;
        font-size: 0.78rem;
        font-weight: 700;
    }

    .account-box span {
        max-width: 12rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .account-box button {
        min-height: 2rem;
        padding: 0 0.65rem;
        color: #007e8f;
        font-size: 0.78rem;
        font-weight: 760;
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
        border: 1px solid #cfd9de;
        border-radius: 8px;
        background: #ffffff;
        color: #111827;
        cursor: pointer;
    }

    button:focus-visible,
    input:focus-visible,
    textarea:focus-visible {
        outline: 3px solid rgba(0, 126, 143, 0.24);
        outline-offset: 2px;
    }

    input,
    textarea {
        width: 100%;
        border: 1px solid #cfd9de;
        border-radius: 8px;
        background: #ffffff;
        color: #111827;
        padding: 0.72rem 0.8rem;
        line-height: 1.4;
        resize: vertical;
    }

    label {
        display: grid;
        gap: 0.35rem;
        color: #5b6770;
        font-size: 0.8rem;
        font-weight: 700;
    }

    label span {
        text-transform: uppercase;
    }

    .section-label,
    .field-label {
        color: #007e8f;
        font-size: 0.76rem;
        font-weight: 800;
        letter-spacing: 0;
        text-transform: uppercase;
    }

    .status-pill {
        border: 1px solid #cfd9de;
        border-radius: 999px;
        background: #ffffff;
        padding: 0.35rem 0.58rem;
        color: #53606a;
        font-size: 0.78rem;
        line-height: 1;
        white-space: nowrap;
    }

    .tab-rail {
        position: fixed;
        z-index: 10;
        right: 0;
        bottom: 0;
        left: 0;
        display: grid;
        grid-template-columns: repeat(5, minmax(0, 1fr));
        border-top: 1px solid #cfd9de;
        background: rgba(255, 255, 255, 0.98);
        box-shadow: 0 -10px 30px rgba(17, 24, 39, 0.08);
    }

    .tab-rail button {
        display: grid;
        justify-items: center;
        gap: 0.18rem;
        min-width: 0;
        min-height: 4.15rem;
        border: 0;
        border-radius: 0;
        background: transparent;
        color: #4b5563;
        font-size: 0.72rem;
        font-weight: 720;
    }

    .tab-rail button.active {
        color: #007e8f;
        box-shadow: inset 0 3px 0 #007e8f;
    }

    .workspace {
        padding: 1rem 0.82rem 5.3rem;
    }

    .sync-line {
        margin-bottom: 0.8rem;
        color: #007e8f;
        font-size: 0.82rem;
        font-weight: 700;
    }

    .tab-panel {
        display: grid;
        gap: 1rem;
    }

    .panel-heading {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
    }

    .study-card,
    .answer-card,
    .edit-panel,
    .empty-state,
    .stats-grid article,
    .timeline-list article,
    .card-list article {
        border: 1px solid #d8e0e4;
        border-radius: 8px;
        background: #ffffff;
        box-shadow: 0 10px 28px rgba(20, 34, 44, 0.06);
    }

    .study-card {
        display: grid;
        gap: 1rem;
        min-height: 17rem;
        padding: 1.2rem;
    }

    .card-meta {
        display: flex;
        justify-content: space-between;
        gap: 0.75rem;
        color: #64727d;
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
        border: 1px solid #00879a;
        border-radius: 999px;
        padding: 0.2rem 0.5rem;
        color: #007e8f;
        font-size: 0.78rem;
        font-weight: 700;
    }

    .answer-card {
        display: grid;
        gap: 0.75rem;
        padding: 1rem;
        color: #1f2937;
        font-size: 1rem;
        line-height: 1.55;
    }

    .answer-card a {
        color: #007e8f;
        font-weight: 700;
        text-decoration: none;
    }

    .primary-action {
        width: 100%;
        min-height: 3rem;
        border-color: #007e8f;
        background: #007e8f;
        color: #ffffff;
        font-weight: 760;
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
    }

    .rating {
        display: grid;
        gap: 0.2rem;
        min-height: 4.2rem;
        padding: 0.5rem 0.2rem;
        border: 0;
        color: #ffffff;
        font-weight: 760;
    }

    .rating small {
        font-size: 0.82rem;
        font-weight: 640;
    }

    .rating.again {
        background: #e9433f;
    }

    .rating.hard {
        background: #e89b13;
    }

    .rating.good {
        background: #2f9f58;
    }

    .rating.easy {
        background: #2878d4;
    }

    .card-form,
    .edit-panel {
        display: grid;
        gap: 0.85rem;
    }

    .card-form {
        border: 1px solid #d8e0e4;
        border-radius: 8px;
        background: #ffffff;
        padding: 1rem;
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
        border: 1px solid #d8e0e4;
        border-radius: 8px;
        background: #ffffff;
        padding: 0.85rem;
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

    .card-list strong,
    .timeline-list strong {
        display: block;
        font-size: 0.98rem;
        line-height: 1.3;
    }

    .card-list p {
        margin-top: 0.25rem;
        color: #4b5563;
        line-height: 1.45;
    }

    .card-list small,
    .timeline-list small {
        display: block;
        margin-top: 0.45rem;
        color: #64727d;
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
        border: 1px solid #cfd9de;
        border-radius: 8px;
        background: #eaf0f2;
    }

    .mode-control button {
        min-height: 2.5rem;
        border: 0;
        background: transparent;
        color: #4b5563;
        font-weight: 760;
    }

    .mode-control button.active {
        background: #ffffff;
        color: #007e8f;
        box-shadow: 0 4px 12px rgba(20, 34, 44, 0.08);
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
    }

    .file-actions strong {
        font-size: 1rem;
    }

    .file-actions span {
        color: #64727d;
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

    .stats-grid span {
        color: #64727d;
        font-size: 0.78rem;
        font-weight: 760;
        text-transform: uppercase;
    }

    .stats-grid strong {
        color: #111827;
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
        background: #eaf7f8;
        color: #007e8f;
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
        color: #4b5563;
    }

    .empty-state h3 {
        color: #111827;
    }

    .empty-state button {
        min-height: 2.6rem;
        padding: 0 0.9rem;
        border-color: #007e8f;
        color: #007e8f;
        font-weight: 760;
    }

    .compact-empty {
        box-shadow: none;
    }

    .inline-status {
        color: #007e8f;
        font-size: 0.88rem;
        font-weight: 700;
    }

    @media (min-width: 760px) {
        .app-shell {
            grid-template-columns: 12rem 1fr;
            grid-template-rows: auto 1fr;
            min-height: min(100vh, 58rem);
            margin: 2rem auto;
            border: 1px solid #d8e0e4;
            border-radius: 8px;
            overflow: hidden;
            box-shadow: 0 24px 70px rgba(20, 34, 44, 0.12);
        }

        .top-bar {
            grid-column: 1 / -1;
            padding: 1.1rem 1.4rem;
        }

        .auth-screen {
            grid-column: 1 / -1;
            max-width: 28rem;
            min-height: 40rem;
            margin: 0 auto;
            background: transparent;
        }

        .tab-rail {
            position: static;
            grid-row: 2;
            grid-template-columns: 1fr;
            align-content: start;
            border-top: 0;
            border-right: 1px solid #d8e0e4;
            box-shadow: none;
        }

        .tab-rail button {
            grid-template-columns: auto 1fr;
            justify-items: start;
            min-height: 3.6rem;
            padding: 0 1rem;
            font-size: 0.88rem;
            text-align: left;
        }

        .tab-rail button.active {
            box-shadow: inset 4px 0 0 #007e8f;
            background: #eef8f9;
        }

        .workspace {
            grid-column: 2;
            grid-row: 2;
            padding: 1.35rem;
            overflow: auto;
        }

        .review-panel {
            max-width: 46rem;
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
