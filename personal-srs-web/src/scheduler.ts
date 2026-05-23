// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

export type Rating = "again" | "hard" | "good" | "easy";
export type CardPhase = "new" | "learning" | "review" | "relearning";

export interface SrsCard {
    id: string;
    deck: string;
    front: string;
    back: string;
    tags: string[];
    source?: string;
    phase: CardPhase;
    dueAt: string;
    createdAt: string;
    updatedAt: string;
    lastReviewedAt?: string;
    intervalDays: number;
    easeFactor: number;
    learningStep: number;
    lapses: number;
    reps: number;
}

export interface ReviewLogEntry {
    id: string;
    cardId: string;
    rating: Rating;
    reviewedAt: string;
    previousPhase: CardPhase;
    nextPhase: CardPhase;
    previousIntervalDays: number;
    nextIntervalDays: number;
    easeFactor: number;
}

export interface CollectionSettings {
    learningStepsMinutes: number[];
    relearningStepsMinutes: number[];
    graduatingIntervalGoodDays: number;
    graduatingIntervalEasyDays: number;
    hardMultiplier: number;
    easyMultiplier: number;
    intervalMultiplier: number;
    lapseMultiplier: number;
    minimumLapseIntervalDays: number;
    maximumReviewIntervalDays: number;
}

export interface SrsCollection {
    version: 1;
    settings: CollectionSettings;
    cards: SrsCard[];
    reviewLog: ReviewLogEntry[];
}

export interface RatingPreview {
    rating: Rating;
    label: string;
    dueLabel: string;
    nextPhase: CardPhase;
}

export const defaultSettings: CollectionSettings = {
    learningStepsMinutes: [1, 10],
    relearningStepsMinutes: [10],
    graduatingIntervalGoodDays: 1,
    graduatingIntervalEasyDays: 4,
    hardMultiplier: 1.2,
    easyMultiplier: 1.3,
    intervalMultiplier: 1,
    lapseMultiplier: 0,
    minimumLapseIntervalDays: 1,
    maximumReviewIntervalDays: 36500,
};

// Browser-local port of the Anki review-state defaults in rslib/src/scheduler/states/review.rs.
const initialEaseFactor = 2.5;
const minimumEaseFactor = 1.3;
const easeFactorAgainDelta = -0.2;
const easeFactorHardDelta = -0.15;
const easeFactorEasyDelta = 0.15;
const minuteMillis = 60 * 1000;
const dayMillis = 24 * 60 * minuteMillis;

export function createEmptyCollection(): SrsCollection {
    return {
        version: 1,
        settings: { ...defaultSettings },
        cards: [],
        reviewLog: [],
    };
}

export function createCard(
    front: string,
    back: string,
    options: Partial<Pick<SrsCard, "deck" | "tags" | "source">> = {},
): SrsCard {
    const now = new Date().toISOString();
    return {
        id: makeId("card"),
        deck: options.deck?.trim() || "Default",
        front: front.trim(),
        back: back.trim(),
        tags: options.tags ?? [],
        source: options.source,
        phase: "new",
        dueAt: now,
        createdAt: now,
        updatedAt: now,
        intervalDays: 0,
        easeFactor: initialEaseFactor,
        learningStep: 0,
        lapses: 0,
        reps: 0,
    };
}

export function answerCard(
    card: SrsCard,
    rating: Rating,
    settings: CollectionSettings,
    reviewedAt = new Date(),
): { card: SrsCard; log: ReviewLogEntry } {
    const previousPhase = card.phase;
    const previousIntervalDays = card.intervalDays;
    const next = nextCardState(card, rating, settings, reviewedAt);
    const reviewedAtIso = reviewedAt.toISOString();
    const updated: SrsCard = {
        ...card,
        ...next,
        reps: card.reps + 1,
        lastReviewedAt: reviewedAtIso,
        updatedAt: reviewedAtIso,
    };

    return {
        card: updated,
        log: {
            id: makeId("review"),
            cardId: card.id,
            rating,
            reviewedAt: reviewedAtIso,
            previousPhase,
            nextPhase: updated.phase,
            previousIntervalDays,
            nextIntervalDays: updated.intervalDays,
            easeFactor: updated.easeFactor,
        },
    };
}

export function previewsForCard(
    card: SrsCard,
    settings: CollectionSettings,
    reviewedAt = new Date(),
): RatingPreview[] {
    return (["again", "hard", "good", "easy"] as Rating[]).map((rating) => {
        const next = nextCardState(card, rating, settings, reviewedAt);
        return {
            rating,
            label: labelForRating(rating),
            dueLabel: formatIntervalLabel(reviewedAt, new Date(next.dueAt)),
            nextPhase: next.phase,
        };
    });
}

export function dueCards(cards: SrsCard[], now = new Date()): SrsCard[] {
    const nowMs = now.getTime();
    return cards
        .filter((card) => new Date(card.dueAt).getTime() <= nowMs)
        .sort((a, b) => {
            const queue = queuePriority(a) - queuePriority(b);
            if (queue !== 0) {
                return queue;
            }

            const due = new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime();
            if (due !== 0) {
                return due;
            }

            return a.createdAt.localeCompare(b.createdAt);
        });
}

export function upcomingCards(cards: SrsCard[], now = new Date()): SrsCard[] {
    const nowMs = now.getTime();
    return cards
        .filter((card) => new Date(card.dueAt).getTime() > nowMs)
        .sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime());
}

export function retentionPercent(reviewLog: ReviewLogEntry[]): number {
    const graded = reviewLog.filter((entry) => entry.rating !== "again");
    if (!reviewLog.length) {
        return 0;
    }

    return Math.round((graded.length / reviewLog.length) * 100);
}

export function reviewsToday(reviewLog: ReviewLogEntry[], now = new Date()): number {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return reviewLog.filter((entry) => new Date(entry.reviewedAt) >= start).length;
}

export function studyStreakDays(reviewLog: ReviewLogEntry[], now = new Date()): number {
    const days = new Set(reviewLog.map((entry) => dateKey(new Date(entry.reviewedAt))));
    let streak = 0;
    const cursor = new Date(now);
    cursor.setHours(0, 0, 0, 0);

    while (days.has(dateKey(cursor))) {
        streak += 1;
        cursor.setDate(cursor.getDate() - 1);
    }

    return streak;
}

export function nextDueLabel(card: SrsCard, now = new Date()): string {
    const due = new Date(card.dueAt);
    if (due.getTime() <= now.getTime()) {
        return "due now";
    }

    return `in ${formatIntervalLabel(now, due)}`;
}

export function formatDateTime(value: string): string {
    return new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
    }).format(new Date(value));
}

function nextCardState(
    card: SrsCard,
    rating: Rating,
    settings: CollectionSettings,
    reviewedAt: Date,
): Pick<
    SrsCard,
    "dueAt" | "easeFactor" | "intervalDays" | "learningStep" | "lapses" | "phase"
> {
    if (card.phase === "new" || card.phase === "learning") {
        return nextLearningState(card, rating, settings, reviewedAt);
    }

    if (card.phase === "relearning") {
        return nextRelearningState(card, rating, settings, reviewedAt);
    }

    return nextReviewState(card, rating, settings, reviewedAt);
}

function nextLearningState(
    card: SrsCard,
    rating: Rating,
    settings: CollectionSettings,
    reviewedAt: Date,
): Pick<
    SrsCard,
    "dueAt" | "easeFactor" | "intervalDays" | "learningStep" | "lapses" | "phase"
> {
    if (rating === "easy") {
        return scheduleReview(card, settings.graduatingIntervalEasyDays, reviewedAt, {
            easeFactor: initialEaseFactor,
        });
    }

    if (
        rating === "good" &&
        card.learningStep >= settings.learningStepsMinutes.length - 1
    ) {
        return scheduleReview(card, settings.graduatingIntervalGoodDays, reviewedAt);
    }

    const maxStep = Math.max(settings.learningStepsMinutes.length - 1, 0);
    const nextStep =
        rating === "again"
            ? 0
            : Math.min(card.learningStep + (rating === "hard" ? 0 : 1), maxStep);
    const minutes =
        rating === "hard"
            ? hardLearningDelay(settings.learningStepsMinutes, card.learningStep)
            : (settings.learningStepsMinutes[nextStep] ??
              settings.learningStepsMinutes[0] ??
              1);

    return {
        dueAt: addMinutes(reviewedAt, minutes).toISOString(),
        easeFactor: card.easeFactor,
        intervalDays: 0,
        learningStep: nextStep,
        lapses: card.lapses,
        phase: "learning",
    };
}

function nextRelearningState(
    card: SrsCard,
    rating: Rating,
    settings: CollectionSettings,
    reviewedAt: Date,
): Pick<
    SrsCard,
    "dueAt" | "easeFactor" | "intervalDays" | "learningStep" | "lapses" | "phase"
> {
    const relearningIntervalDays = clampDays(
        Math.round(
            Math.max(
                Math.max(card.intervalDays, 1) * settings.lapseMultiplier,
                settings.minimumLapseIntervalDays,
            ),
        ),
        settings,
    );

    if (rating === "again") {
        return {
            dueAt: addMinutes(
                reviewedAt,
                settings.relearningStepsMinutes[0] ?? 10,
            ).toISOString(),
            easeFactor: card.easeFactor,
            intervalDays: relearningIntervalDays,
            learningStep: 0,
            lapses: card.lapses,
            phase: "relearning",
        };
    }

    const maxStep = Math.max(settings.relearningStepsMinutes.length - 1, 0);
    const nextStep =
        rating === "good"
            ? Math.min(card.learningStep + 1, maxStep)
            : card.learningStep;

    if (rating === "hard") {
        return {
            dueAt: addMinutes(
                reviewedAt,
                hardLearningDelay(settings.relearningStepsMinutes, card.learningStep),
            ).toISOString(),
            easeFactor: card.easeFactor,
            intervalDays: relearningIntervalDays,
            learningStep: nextStep,
            lapses: card.lapses,
            phase: "relearning",
        };
    }

    if (
        rating === "good" &&
        card.learningStep < settings.relearningStepsMinutes.length - 1
    ) {
        return {
            dueAt: addMinutes(
                reviewedAt,
                settings.relearningStepsMinutes[nextStep] ??
                    settings.relearningStepsMinutes[0] ??
                    10,
            ).toISOString(),
            easeFactor: card.easeFactor,
            intervalDays: relearningIntervalDays,
            learningStep: nextStep,
            lapses: card.lapses,
            phase: "relearning",
        };
    }

    const intervalDays =
        rating === "easy"
            ? clampDays(relearningIntervalDays + 1, settings)
            : relearningIntervalDays;

    return scheduleReview(card, intervalDays, reviewedAt);
}

function nextReviewState(
    card: SrsCard,
    rating: Rating,
    settings: CollectionSettings,
    reviewedAt: Date,
): Pick<
    SrsCard,
    "dueAt" | "easeFactor" | "intervalDays" | "learningStep" | "lapses" | "phase"
> {
    const scheduled = Math.max(card.intervalDays, 1);
    const elapsed = Math.max(
        daysBetween(card.lastReviewedAt ?? card.dueAt, reviewedAt),
        0,
    );
    const daysLate = Math.max(elapsed - scheduled, 0);

    if (rating === "again") {
        const intervalDays = clampDays(
            Math.round(
                Math.max(
                    scheduled * settings.lapseMultiplier,
                    settings.minimumLapseIntervalDays,
                ),
            ),
            settings,
        );

        return {
            dueAt: addMinutes(
                reviewedAt,
                settings.relearningStepsMinutes[0] ?? 10,
            ).toISOString(),
            easeFactor: Math.max(
                minimumEaseFactor,
                card.easeFactor + easeFactorAgainDelta,
            ),
            intervalDays,
            learningStep: 0,
            lapses: card.lapses + 1,
            phase: "relearning",
        };
    }

    if (rating === "hard") {
        const minimum = settings.hardMultiplier <= 1 ? 1 : scheduled + 1;
        return scheduleReview(
            card,
            constrainReviewInterval(
                scheduled * settings.hardMultiplier,
                minimum,
                settings,
            ),
            reviewedAt,
            {
                easeFactor: Math.max(
                    minimumEaseFactor,
                    card.easeFactor + easeFactorHardDelta,
                ),
            },
        );
    }

    if (rating === "good") {
        const hardInterval = constrainReviewInterval(
            scheduled * settings.hardMultiplier,
            settings.hardMultiplier <= 1 ? 1 : scheduled + 1,
            settings,
        );
        const minimum = settings.hardMultiplier <= 1 ? scheduled + 1 : hardInterval + 1;
        return scheduleReview(
            card,
            constrainReviewInterval(
                (scheduled + daysLate / 2) * card.easeFactor,
                minimum,
                settings,
            ),
            reviewedAt,
        );
    }

    const goodInterval = constrainReviewInterval(
        (scheduled + daysLate / 2) * card.easeFactor,
        scheduled + 1,
        settings,
    );
    return scheduleReview(
        card,
        constrainReviewInterval(
            (scheduled + daysLate) * card.easeFactor * settings.easyMultiplier,
            goodInterval + 1,
            settings,
        ),
        reviewedAt,
        { easeFactor: card.easeFactor + easeFactorEasyDelta },
    );
}

function scheduleReview(
    card: SrsCard,
    intervalDays: number,
    reviewedAt: Date,
    changes: Partial<Pick<SrsCard, "easeFactor">> = {},
): Pick<
    SrsCard,
    "dueAt" | "easeFactor" | "intervalDays" | "learningStep" | "lapses" | "phase"
> {
    const rounded = Math.max(Math.round(intervalDays), 1);
    return {
        dueAt: addDays(reviewedAt, rounded).toISOString(),
        easeFactor: changes.easeFactor ?? card.easeFactor,
        intervalDays: rounded,
        learningStep: 0,
        lapses: card.lapses,
        phase: "review",
    };
}

function constrainReviewInterval(
    intervalDays: number,
    minimum: number,
    settings: CollectionSettings,
): number {
    return clampDays(
        Math.round(intervalDays * settings.intervalMultiplier),
        settings,
        minimum,
    );
}

function clampDays(days: number, settings: CollectionSettings, minimum = 1): number {
    return Math.min(
        Math.max(days, minimum),
        Math.max(settings.maximumReviewIntervalDays, 1),
    );
}

function hardLearningDelay(steps: number[], currentStep: number): number {
    const current = steps[currentStep] ?? steps[0] ?? 1;
    const next = steps[Math.min(currentStep + 1, steps.length - 1)] ?? current;
    if (currentStep === 0 && steps.length === 1) {
        return Math.max(1, Math.min(Math.round(current * 1.5), current + 1440));
    }

    return Math.max(1, Math.round((current + next) / 2));
}

function queuePriority(card: SrsCard): number {
    if ((card.phase === "learning" || card.phase === "relearning") && card.reps > 0) {
        return 0;
    }

    if (card.phase === "review" || card.phase === "relearning") {
        return 1;
    }

    return 2;
}

function addMinutes(date: Date, minutes: number): Date {
    return new Date(date.getTime() + minutes * minuteMillis);
}

function addDays(date: Date, days: number): Date {
    return new Date(date.getTime() + days * dayMillis);
}

function daysBetween(previous: string, next: Date): number {
    return Math.floor((next.getTime() - new Date(previous).getTime()) / dayMillis);
}

function formatIntervalLabel(start: Date, end: Date): string {
    const millis = Math.max(end.getTime() - start.getTime(), 0);
    const minutes = Math.max(Math.round(millis / minuteMillis), 1);
    if (minutes < 60) {
        return `${minutes}m`;
    }

    const hours = Math.round(minutes / 60);
    if (hours < 36) {
        return `${hours}h`;
    }

    const days = Math.round(hours / 24);
    return `${days}d`;
}

function labelForRating(rating: Rating): string {
    return rating[0].toUpperCase() + rating.slice(1);
}

function dateKey(date: Date): string {
    return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function makeId(prefix: string): string {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
        return `${prefix}_${crypto.randomUUID()}`;
    }

    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}
