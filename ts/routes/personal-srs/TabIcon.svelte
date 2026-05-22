<!--
Copyright: Ankitects Pty Ltd and contributors
License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html
-->
<script lang="ts">
    export let name: "review" | "create" | "cards" | "files" | "stats";
</script>

<svg class="tab-icon" viewBox="0 0 24 24" aria-hidden="true">
    {#if name === "review"}
        <rect x="5" y="4" width="14" height="16" rx="2" />
        <path d="M8 8h8M8 12h5M8 16h7" />
    {:else if name === "create"}
        <path d="M12 5v14M5 12h14" />
        <rect x="4" y="4" width="16" height="16" rx="3" />
    {:else if name === "cards"}
        <rect x="5" y="7" width="12" height="13" rx="2" />
        <path d="M8 4h11v13" />
    {:else if name === "files"}
        <path d="M8 3h6l4 4v14H8z" />
        <path d="M14 3v5h4M5 8v12h9" />
    {:else}
        <path d="M5 19V9M12 19V5M19 19v-7" />
        <path d="M3 19h18" />
    {/if}
</svg>

<style lang="scss">
    .tab-icon {
        width: 1.45rem;
        height: 1.45rem;
        fill: none;
        stroke: currentColor;
        stroke-linecap: round;
        stroke-linejoin: round;
        stroke-width: 2;
    }
</style>
