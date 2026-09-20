# Changelog

Griffin Archive began in August 2020 as a Create React App project and was rebuilt over a nine-phase overhaul. This file narrates that
rebuild rather than listing every commit; the git history has the detail.

## The overhaul

### Phase 0 - Safety net

Before anything moved, the risky parts were proven in isolation: that the game's Spine rigs could be driven in a browser, that Live2D
models could be converted, and that the asset repositories could be rebuilt from scratch and restored from a bundle. Nothing was
migrated on the assumption it would work.

### Phase 1 - Assets out of git

Art, Spine rigs and Live2D models moved into a separate repository, `gfl-archive-assets`, read over raw GitHub links. The site repo had
grown to roughly 6 GB with game art committed alongside code; afterwards it carried none. Every asset URL is built by a helper in
`src/lib/assets.ts`, so the host stays switchable, and `assets-manifest.json` records what actually exists rather than the site
guessing from an id.

### Phase 2 - Vite and TypeScript

Create React App gave way to Vite and strict TypeScript, with `noUncheckedIndexedAccess` on. Routes became lazy chunks and the
generated data was sharded so a page downloads only what it renders. Deployment moved to a GitHub Actions workflow that builds and
publishes on every push to `master`.

### Phase 3 - Interface

The interface was rebuilt on MUI with a shared theme, so colours and typography come from `src/theme/` rather than being repeated
inline. Light mode was dropped as a deliberate non-goal.

### Phase 4 - Data importer

`tools/data/` replaced hand-maintained data with a generator that reads the game's own tables from the
[gf-data-us](https://github.com/gf-data-tools/gf-data-us) checkout, cross-checks against the Chinese tables, and fills gaps from
IOPWiki and Wikidata. `tools/data/check.mjs` refuses a regeneration that silently drops records.

### Phase 5 - Feature backlog

The long-standing wish list was cleared: HOC and Fairy indexes, build times, exclusive equipment linked to its T-Doll, tooltips on
skill text, and paging on the T-Doll index.

### Phase 6 - Story player

A clean-room parser for the game's `avgtxt` cutscene scripts, and a player that reads them. The scripts are taken from the same
upstream checkout the rest of the data comes from, so they stay current without a separate translation fork to maintain.

### Phase 7 - Formation simulator

Echelon placement on the game's 3x3 grid with tile and fairy buffs resolved per doll, an opposing enemy squad, and a damage estimate.
A build is shareable as a URL.

### Phase 8 - Documentation

The README was rewritten for the current stack, and this file was added.

## Where it ended up

| | |
|---|---|
| T-Dolls | 457, with 82 Mods |
| Equipment | 474 |
| Enemies | 351, with 57 capturable |
| HOCs and Fairies | 11 and 47 |
| Story | 51 chapters, 1,406 scenes |
| Story art | 1,017 sprites, 380 backgrounds |
| Story audio | 383 cues |

## Known gaps

These are limits of the shipped game data, not unfinished work.

- **66 music cues** are named by the scripts but are not in the current build. The game's own cue table marks them as an older event
  format. Those moments play no music.
- **Mid-scene background changes** cannot be resolved. A script switches background by an index the game resolves in code that is not
  distributed, so backgrounds change per mission rather than per beat.
- **A small number of sprite slots** show nobody. Most are not characters at all: scripts use the same slot to carry an off-screen
  speaker's label, such as a description of a voice.

## Rebuilding

`pnpm build` needs only Node and pnpm. Regenerating data needs a `gf-data-us` checkout; rebuilding art needs Python and UnityPy, and
rebuilding audio also needs [vgmstream](https://github.com/vgmstream/vgmstream/releases) and `ffmpeg`. See the README for details.
