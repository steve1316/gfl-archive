import { useCallback, useMemo, useState } from "react";
import type { MouseEvent } from "react";

// MaterialUI imports
import { ToggleButton, ToggleButtonGroup } from "@mui/material";

import Live2dStage from "../../components/Live2dStage";
import SpineStage from "../../components/SpineStage";
import { STRIPED_STAGE_SX, TOGGLE_ROW_SX } from "../../components/stageStyles";
import { hocLive2dModelUrl, hocSpineImageBase, hocSpineUrl } from "../../lib/assets";
import { hasHocLive2d } from "../../lib/processData";
import { useHocLive2dMotions } from "../../lib/useLive2dMotions";
import type { HocSpineEntry } from "../../types/spine";

/** Props for HocAnimationsPanel. */
interface HocAnimationsPanelProps {
	/** The HOC's id, used to build the Spine and Live2D asset URLs. */
	hocId: number;
	/** The HOC's published rigs: the combat rig and its crew. */
	entry: HocSpineEntry;
}

/**
 * A HOC's chibi animations: a toggle between the battle rig, each crew rig and, when the manifest lists one, the HOC's Live2D model, then
 * archive-kit's animation stage. A tap steps to the next animation or motion, as on the T-Doll page.
 *
 * @param props Component props.
 * @returns The rig toggle and the stage.
 */
export default function HocAnimationsPanel({ hocId, entry }: HocAnimationsPanelProps) {
	const rigs = useMemo(() => [entry.combat, ...entry.crew], [entry]);
	const [rigIndex, setRigIndex] = useState(0);
	// Whether the Live2D option is selected, instead of one of the Spine rigs. Kept separate from `rigIndex` so leaving
	// Live2D and coming back returns to the same rig.
	const [live2dActive, setLive2dActive] = useState(false);

	const rig = rigs[rigIndex] ?? entry.combat;
	const hasLive2d = hasHocLive2d(hocId);
	const motions = useHocLive2dMotions(hasLive2d ? hocId : undefined);

	const handleModeChange = useCallback((_event: MouseEvent<HTMLElement>, value: number | "live2d" | null) => {
		// Clicking the selected button hands back null, which would leave no rig chosen.
		if (value === null) {
			return;
		}
		if (value === "live2d") {
			setLive2dActive(true);
			return;
		}
		setLive2dActive(false);
		setRigIndex(value);
	}, []);

	return (
		<>
			<ToggleButtonGroup size="small" value={live2dActive ? "live2d" : rigIndex} exclusive onChange={handleModeChange} sx={TOGGLE_ROW_SX} aria-label="Rig">
				{rigs.map((_rig, index) => (
					<ToggleButton key={index} value={index}>
						{index === 0 ? "Battle" : `Crew ${index}`}
					</ToggleButton>
				))}
				{hasLive2d ? <ToggleButton value="live2d">Live2D</ToggleButton> : null}
			</ToggleButtonGroup>

			{live2dActive ? (
				<Live2dStage modelUrl={hocLive2dModelUrl(hocId)} motions={motions} label="HOC Live2D model" sx={STRIPED_STAGE_SX} />
			) : (
				<SpineStage
					skelUrl={hocSpineUrl(hocId, rig.skel, "skel")}
					atlasUrl={hocSpineUrl(hocId, rig.atlas, "atlas")}
					imageBase={hocSpineImageBase(hocId)}
					anims={rig.anims}
					label="HOC chibi animation"
					sx={STRIPED_STAGE_SX}
				/>
			)}
		</>
	);
}
