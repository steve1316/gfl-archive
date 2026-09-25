# Griffin Archive

An unofficial archive for _Girls' Frontline_, the mobile game by MICA Team: T-Dolls, equipment, HOCs, fairies and enemies, with their art, Spine chibis and Live2D models. It runs entirely in the browser and is hosted on GitHub Pages.

**[Open Griffin Archive](https://steve1316.github.io/gfl-archive/)**

[![Deploy](https://github.com/steve1316/gfl-archive/actions/workflows/deploy.yml/badge.svg)](https://github.com/steve1316/gfl-archive/actions/workflows/deploy.yml)
[![Refresh game data](https://github.com/steve1316/gfl-archive/actions/workflows/refresh.yml/badge.svg)](https://github.com/steve1316/gfl-archive/actions/workflows/refresh.yml)
[![Last commit](https://img.shields.io/github/last-commit/steve1316/gfl-archive)](https://github.com/steve1316/gfl-archive/commits/master)
[![License](https://img.shields.io/github/license/steve1316/gfl-archive)](LICENSE)

![A T-Doll page playing a skin's Live2D model](https://raw.githubusercontent.com/steve1316/gfl-archive-assets/main/readme/tdoll-page.webp)

## Features

- **T-Doll Index** - filter by rarity, type, Mod and Live2D, search by name or build time, and sort by ID, name, rarity or Global release.
- **T-Doll pages** - stats, skills at any level, tile buffs, profile and gun spec sheet, exclusive equipment, and every skin and Mod with a zoomable full-art viewer.
- **Animations** - battle and dorm chibis from the game's Spine rigs, plus skin Live2D models with their motions and dialogue.
- **HOCs and Fairies** - their own indexes and pages with stats, skills, fairy talents, art and animations, including Live2D where the game has it.
- **Equipment Index** - filter, search and sort equipment, and see which dolls an exclusive item belongs to.
- **Enemy Index** - every enemy with its stats, skills and counter tips, plus the Protocol Assimilation units you can capture and field yourself.
- **Formation Simulator** - place an echelon and a facing enemy squad, apply tile and fairy buffs, and compare damage estimates. Share a setup by its link.
- **Story player** - read 51 chapters of main story and events in the browser, with the game's own backgrounds, character art, music and sound effects. Branching scenes let you pick, and it reads on a phone in either orientation.
- **Always current** - a daily job picks up new dolls, skins, equipment and art from the game data.

<p>
  <img src="https://raw.githubusercontent.com/steve1316/gfl-archive-assets/main/readme/tdoll-index.webp" width="49%" alt="The T-Doll Index with its filters">
  <img src="https://raw.githubusercontent.com/steve1316/gfl-archive-assets/main/readme/hoc-page.webp" width="49%" alt="A HOC page">
</p>

## Running locally

You need Node 22 and pnpm, which ships with Node through corepack.

```sh
corepack enable
pnpm install
pnpm dev          # dev server at http://localhost:5173/gfl-archive/
pnpm typecheck    # type check only
pnpm build        # type check, then a production build into build/
pnpm preview      # serve the production build
pnpm test:data    # data pipeline tests
```

To serve the production build the way GitHub Pages does, but from the site root, run `docker compose up --build` and open http://localhost:8088.

Art and animations are not in this repo. They load from [gfl-archive-assets](https://github.com/steve1316/gfl-archive-assets), set by `VITE_ASSET_BASE_URL` in `.env`.

## How it works

- **`src/`** - the site: React 19, TypeScript and MUI, built with Vite. Game data ships as generated JSON, and each page loads only what it needs.
- **`tools/data/`** - imports doll, equipment, HOC, fairy and enemy data from the game's tables and checks the result.
- **`tools/story/`** - parses the game's own cutscene scripts into the scenes the story player reads.
- **`tools/assets/`** - Python tools (UnityPy, Python 3.12) that extract art, Spine rigs and Live2D models from the game's asset bundles and publish them to the asset repo. `story_audio.py` also builds the story's music and sound effects, which needs [vgmstream](https://github.com/vgmstream/vgmstream/releases) unpacked to `tools/assets/.tools/vgmstream/` and `ffmpeg` on the path. The binary is not committed, so fetch it before rebuilding audio.
- **`.github/workflows/`** - `deploy.yml` publishes the site on every push to `master`. `refresh.yml` runs daily, imports anything new, and deploys only if something changed.

## Data sources

- **Game data** - stats, skills, profiles and release dates from [gf-data-us](https://github.com/gf-data-tools/gf-data-us), cross-checked against [gf-data-ch](https://github.com/gf-data-tools/gf-data-ch).
- **Faction, manufacturer, country, full gun name and story music titles** - [IOPWiki](https://iopwiki.com/) under [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/), with the profile fields' gaps filled from [Wikidata](https://www.wikidata.org/) (CC0).
- **Art and animations** - extracted from the game's own asset bundles.

## Credits

- **Spine 2.1 runtime** - vendored from [naganeko-tools](https://github.com/naganeko/naganeko-tools) (GPL-3.0).
- **Live2D Cubism Core** - © Live2D Inc., redistributed under the Live2D Proprietary Software License Agreement.
- **pixi-live2d-display** and **PixiJS** - MIT.

Versions and licence details are in [`public/vendor/`](public/vendor/).

_Girls' Frontline_ and its characters, art and data are © Sunborn / MICA Team. This is an unofficial fan project and is not affiliated with or endorsed by them.

## License

The code is licensed under [GPL-3.0](LICENSE).
