import { createEmptyCollection, type ReviewLogEntry, type SrsCard } from "./scheduler";
import { supabase } from "./supabase";

type CardRow = {
    id: string;
    deck: string;
    front: string;
    back: string;
    tags: string[];
    source: string | null;
    phase: SrsCard["phase"];
    due_at: string;
    created_at: string;
    updated_at: string;
    last_reviewed_at: string | null;
    interval_days: number;
    ease_factor: number;
    learning_step: number;
    lapses: number;
    reps: number;
};

type ReviewLogRow = {
    id: string;
    card_id: string | null;
    rating: ReviewLogEntry["rating"];
    reviewed_at: string;
    previous_phase: ReviewLogEntry["previousPhase"];
    next_phase: ReviewLogEntry["nextPhase"];
    previous_interval_days: number;
    next_interval_days: number;
    ease_factor: number;
};

export async function loadRemoteCollection(userId: string) {
    const [cardsResult, logsResult, settingsResult] = await Promise.all([
        supabase
            .from("srs_cards")
            .select("*")
            .eq("user_id", userId)
            .order("due_at", { ascending: true }),
        supabase
            .from("srs_review_logs")
            .select("*")
            .eq("user_id", userId)
            .order("reviewed_at", { ascending: false })
            .limit(500),
        supabase
            .from("srs_settings")
            .select("settings")
            .eq("user_id", userId)
            .maybeSingle(),
    ]);

    if (cardsResult.error) {
        throw cardsResult.error;
    }
    if (logsResult.error) {
        throw logsResult.error;
    }
    if (settingsResult.error) {
        throw settingsResult.error;
    }

    const empty = createEmptyCollection();
    return {
        version: 1 as const,
        settings: {
            ...empty.settings,
            ...(settingsResult.data?.settings as Partial<typeof empty.settings> | null),
        },
        cards: ((cardsResult.data ?? []) as CardRow[]).map(rowToCard),
        reviewLog: ((logsResult.data ?? []) as ReviewLogRow[]).map(rowToReviewLog),
    };
}

export async function insertRemoteCard(
    card: SrsCard,
    userId: string,
): Promise<SrsCard> {
    const { data, error } = await supabase
        .from("srs_cards")
        .insert(cardToInsert(card, userId))
        .select("*")
        .single();

    if (error) {
        throw error;
    }

    return rowToCard(data as CardRow);
}

export async function insertRemoteCards(
    cards: SrsCard[],
    userId: string,
): Promise<SrsCard[]> {
    if (!cards.length) {
        return [];
    }

    const { data, error } = await supabase
        .from("srs_cards")
        .insert(cards.map((card) => cardToInsert(card, userId)))
        .select("*");

    if (error) {
        throw error;
    }

    return ((data ?? []) as CardRow[]).map(rowToCard);
}

export async function updateRemoteCard(card: SrsCard): Promise<SrsCard> {
    const { data, error } = await supabase
        .from("srs_cards")
        .update(cardToUpdate(card))
        .eq("id", card.id)
        .select("*")
        .single();

    if (error) {
        throw error;
    }

    return rowToCard(data as CardRow);
}

export async function deleteRemoteCard(cardId: string): Promise<void> {
    const { error } = await supabase.from("srs_cards").delete().eq("id", cardId);

    if (error) {
        throw error;
    }
}

export async function insertRemoteReviewLog(
    entry: ReviewLogEntry,
    userId: string,
): Promise<ReviewLogEntry> {
    const { data, error } = await supabase
        .from("srs_review_logs")
        .insert({
            user_id: userId,
            card_id: entry.cardId,
            rating: entry.rating,
            reviewed_at: entry.reviewedAt,
            previous_phase: entry.previousPhase,
            next_phase: entry.nextPhase,
            previous_interval_days: entry.previousIntervalDays,
            next_interval_days: entry.nextIntervalDays,
            ease_factor: entry.easeFactor,
        })
        .select("*")
        .single();

    if (error) {
        throw error;
    }

    return rowToReviewLog(data as ReviewLogRow);
}

export async function replaceRemoteCollection(
    cards: SrsCard[],
    userId: string,
): Promise<SrsCard[]> {
    const [logsDelete, cardsDelete] = await Promise.all([
        supabase.from("srs_review_logs").delete().eq("user_id", userId),
        supabase.from("srs_cards").delete().eq("user_id", userId),
    ]);

    if (logsDelete.error) {
        throw logsDelete.error;
    }
    if (cardsDelete.error) {
        throw cardsDelete.error;
    }

    return insertRemoteCards(cards, userId);
}

function rowToCard(row: CardRow): SrsCard {
    return {
        id: row.id,
        deck: row.deck,
        front: row.front,
        back: row.back,
        tags: row.tags ?? [],
        source: row.source ?? undefined,
        phase: row.phase,
        dueAt: row.due_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastReviewedAt: row.last_reviewed_at ?? undefined,
        intervalDays: row.interval_days,
        easeFactor: row.ease_factor,
        learningStep: row.learning_step,
        lapses: row.lapses,
        reps: row.reps,
    };
}

function rowToReviewLog(row: ReviewLogRow): ReviewLogEntry {
    return {
        id: row.id,
        cardId: row.card_id ?? "",
        rating: row.rating,
        reviewedAt: row.reviewed_at,
        previousPhase: row.previous_phase,
        nextPhase: row.next_phase,
        previousIntervalDays: row.previous_interval_days,
        nextIntervalDays: row.next_interval_days,
        easeFactor: row.ease_factor,
    };
}

function cardToInsert(card: SrsCard, userId: string) {
    return {
        user_id: userId,
        deck: card.deck,
        front: card.front,
        back: card.back,
        tags: card.tags,
        source: card.source ?? null,
        phase: card.phase,
        due_at: card.dueAt,
        created_at: card.createdAt,
        updated_at: card.updatedAt,
        last_reviewed_at: card.lastReviewedAt ?? null,
        interval_days: card.intervalDays,
        ease_factor: card.easeFactor,
        learning_step: card.learningStep,
        lapses: card.lapses,
        reps: card.reps,
    };
}

function cardToUpdate(card: SrsCard) {
    return {
        deck: card.deck,
        front: card.front,
        back: card.back,
        tags: card.tags,
        source: card.source ?? null,
        phase: card.phase,
        due_at: card.dueAt,
        updated_at: card.updatedAt,
        last_reviewed_at: card.lastReviewedAt ?? null,
        interval_days: card.intervalDays,
        ease_factor: card.easeFactor,
        learning_step: card.learningStep,
        lapses: card.lapses,
        reps: card.reps,
    };
}
