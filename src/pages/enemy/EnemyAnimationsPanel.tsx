import { memo, useCallback, useMemo, useState } from "react";
import type { MouseEvent } from "react";

// MaterialUI imports
import { ToggleButton, ToggleButtonGroup } from "@mui/material";
import type { SxProps, Theme } from "@mui/material";

import SpineStage from "../../components/SpineStage";
import { STRIPED_STAGE_SX } from "../../components/stageStyles";
import { enemySpineImageBase, enemySpineUrl } from "../../lib/assets";
import type { SpineRig } from "../../types/spine";

/**
 * The dorm poses, which a captured unit plays in the dormitory and an enemy never plays at all.
 *
 * A doll keeps these in a second rig, so its page can offer Battle and Dorm as two sources. The 58 enemies that Protocol
 * Assimilation makes playable keep them inside the one combat rig instead. Splitting them here gives those enemies the same
 * two-way toggle a doll has, over the same skeleton.
 */
const DORM_ANIMATIONS = new Set(["lying", "pick", "r_move", "r_wait", "sit"]);

const styles = {
	// The same full-width toggle the doll's chibi panel uses for its own Battle/Dorm picker.
	toggleRow: {
		width: "100%",
		mb: 1,
		"& .MuiToggleButton-root": { flex: 1 }
	}
} satisfies Record<string, SxProps<Theme>>;

/** Props for EnemyAnimationsPanel. */
interface EnemyAnimationsPanelProps {
	/** Enemy id, used to build the rig's URLs. */
	id: number;
	/** The enemy's rig. */
	rig: SpineRig;
}

/**
 * One enemy's chibi, with the doll page's own controls: a Battle/Dorm toggle when the rig has dorm poses, then archive-kit's animation stage.
 * Both modes play the same skeleton, so the toggle only changes which animations a tap steps through.
 *
 * @param props Component props.
 * @returns The mode toggle and the stage.
 */
export default memo(function EnemyAnimationsPanel({ id, rig }: EnemyAnimationsPanelProps) {
	const [dorm, setDorm] = useState(false);

	const names = useMemo(() => ({ battle: rig.anims.filter((name) => !DORM_ANIMATIONS.has(name)), dorm: rig.anims.filter((name) => DORM_ANIMATIONS.has(name)) }), [rig.anims]);

	const handleModeChange = useCallback((_event: MouseEvent<HTMLElement>, value: "battle" | "dorm" | null) => {
		// Clicking the selected button hands back null, which would leave no mode chosen.
		if (value !== null) {
			setDorm(value === "dorm");
		}
	}, []);

	return (
		<>
			{names.dorm.length > 0 ? (
				<ToggleButtonGroup size="small" value={dorm ? "dorm" : "battle"} exclusive onChange={handleModeChange} sx={styles.toggleRow} aria-label="Animation mode">
					<ToggleButton value="battle">Battle</ToggleButton>
					<ToggleButton value="dorm">Dorm</ToggleButton>
				</ToggleButtonGroup>
			) : null}

			<SpineStage
				skelUrl={enemySpineUrl(id, rig.skel, "skel")}
				atlasUrl={enemySpineUrl(id, rig.atlas, "atlas")}
				imageBase={enemySpineImageBase(id)}
				anims={dorm ? names.dorm : names.battle}
				label="Enemy chibi animation"
				sx={STRIPED_STAGE_SX}
			/>
		</>
	);
});
