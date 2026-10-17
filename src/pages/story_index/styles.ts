import type { SxProps, Theme } from "@mui/material";

/** The card both panes sit in. Clipped rather than hidden, so the phone list's headings can stick to the page as it scrolls. */
export const pane = { bgcolor: "background.paper", border: 1, borderColor: "divider", borderRadius: 2.5, overflow: "clip" } satisfies SxProps<Theme>;
