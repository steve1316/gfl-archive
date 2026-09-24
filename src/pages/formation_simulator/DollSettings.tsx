import { memo, useCallback, useEffect, useState } from "react";

import { Box, MenuItem, TextField, ToggleButton, ToggleButtonGroup, Typography } from "@mui/material";

import LevelSlider from "../../components/LevelSlider";
import SpineStage from "../../components/SpineStage";
import { spineImageBase, spineUrl } from "../../lib/assets";
import { loadSpineRigs } from "../../lib/data";
import { MAX_LINKS, MAX_SKILL_LEVEL, levelCap, maxModStage } from "../../lib/formation/pipeline";
import type { AffectionLevel, DollSetup, EffectiveDoll, StatKey } from "../../lib/formation/pipeline";
import type { FormationData } from "../../types/formation";
import type { SpineRig } from "../../types/spine";

/** The preview plays only the idle loop, with no caption and no stepping. A constant, so the stage never sees a new list. */
const PREVIEW_ANIMATIONS: readonly string[] = ["wait"];

/** The preview's box: the same 220px raised panel it has always had. */
const PREVIEW_STAGE_SX = { height: 220, borderRadius: "8px", bgcolor: "raised" } as const;

/** Stats shown in the preview, with their labels. */
const PREVIEW_STATS: readonly [StatKey, string][] = [
	["hp", "HP"],
	["dmg", "DMG"],
	["acc", "ACC"],
	["eva", "EVA"],
	["rof", "RoF"],
	["armor", "Armor"],
	["crit", "Crit %"]
];

/** Affection bucket labels. */
const AFFECTION_LABELS = ["Normal", "90+", "Oath"] as const;

/** Skill level options, 1 to the max. */
const SKILL_LEVELS = Array.from({ length: MAX_SKILL_LEVEL }, (_, index) => index + 1);

/** Dummy link options, 1 to the max. */
const LINK_COUNTS = Array.from({ length: MAX_LINKS }, (_, index) => index + 1);

/** Props for SkillLevelSelect. */
interface SkillLevelSelectProps {
	/** Field label. */
	label: string;
	/** Current skill level. */
	value: number;
	/** A level was picked. */
	onChange: (level: number) => void;
}

/** Props for DollSettings. */
interface DollSettingsProps {
	/** Formation data. */
	data: FormationData;
	/** The doll's setup. */
	setup: DollSetup;
	/** The doll's computed result, or undefined while it is being placed. */
	result: EffectiveDoll | undefined;
	/** Change settings. */
	onChange: (patch: Partial<Omit<DollSetup, "cell" | "dollId">>) => void;
}

/**
 * A skill level dropdown, 1 to the max.
 *
 * @param props Component props.
 * @returns The dropdown.
 */
function SkillLevelSelect({ label, value, onChange }: SkillLevelSelectProps) {
	return (
		<TextField select size="small" label={label} value={value} onChange={(event) => onChange(Number(event.target.value))} sx={{ minWidth: 140 }}>
			{SKILL_LEVELS.map((level) => (
				<MenuItem key={level} value={level}>
					{level}
				</MenuItem>
			))}
		</TextField>
	);
}

/**
 * Step 2 of the doll modal: a live chibi and stat preview, and the doll's settings.
 *
 * @param props Component props.
 * @returns The settings panel.
 */
export default memo(function DollSettings({ data, setup, result, onChange }: DollSettingsProps) {
	const [rig, setRig] = useState<SpineRig | undefined>(undefined);
	const topStage = maxModStage(setup.dollId, data.forms);
	const cap = levelCap(setup.modStage, data.constants);

	useEffect(() => {
		let active = true;
		setRig(undefined);
		// A failed rig lookup is logged and leaves the preview empty.
		void loadSpineRigs(setup.dollId)
			.then((rigs) => {
				if (active) {
					setRig(setup.modStage > 0 ? rigs?.mod?.combat : rigs?.combat);
				}
			})
			.catch((error: unknown) => console.error(`Chibi preview for doll ${setup.dollId} failed to load:`, error));
		return () => {
			active = false;
		};
	}, [setup.dollId, setup.modStage]);

	const handleLevel = useCallback((level: number) => onChange({ level }), [onChange]);

	return (
		<Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: "240px 1fr" }, gap: 3 }}>
			<Box>
				{rig ? (
					<SpineStage
						skelUrl={spineUrl(setup.dollId, rig.skel, "skel")}
						atlasUrl={spineUrl(setup.dollId, rig.atlas, "atlas")}
						imageBase={spineImageBase(setup.dollId, rig.atlas)}
						anims={PREVIEW_ANIMATIONS}
						label="Doll preview animation"
						interactive={false}
						sx={PREVIEW_STAGE_SX}
					/>
				) : (
					<Box sx={PREVIEW_STAGE_SX} />
				)}
				<Box component="table" sx={{ width: "100%", mt: 1.5, borderCollapse: "collapse", "& td": { py: 0.4, borderBottom: 1, borderColor: "divider", fontSize: 13 } }}>
					<tbody>
						{result &&
							PREVIEW_STATS.map(([stat, label]) => {
								const changed = result.stats[stat] !== result.base[stat];
								return (
									<tr key={stat}>
										<td>{label}</td>
										<Box component="td" sx={{ textAlign: "right", color: changed ? "secondary.main" : "text.primary", fontVariantNumeric: "tabular-nums" }}>
											{result.stats[stat]}
											{stat === "rof" && result.rofCapped ? " (cap)" : ""}
										</Box>
									</tr>
								);
							})}
					</tbody>
				</Box>
			</Box>
			<Box sx={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
				<Box>
					<Typography variant="body2" color="text.secondary" gutterBottom>
						Form
					</Typography>
					<ToggleButtonGroup exclusive size="small" value={setup.modStage} onChange={(_event, value: number | null) => value !== null && onChange({ modStage: value })} aria-label="Form">
						<ToggleButton value={0}>Base</ToggleButton>
						{topStage > 0 && <ToggleButton value={1}>MOD 1</ToggleButton>}
						{topStage > 0 && <ToggleButton value={2}>MOD 2</ToggleButton>}
						{topStage > 0 && <ToggleButton value={3}>MOD 3</ToggleButton>}
					</ToggleButtonGroup>
				</Box>
				<LevelSlider id={`formation-level-${setup.cell}`} label="Level" value={setup.level} max={cap} onChange={handleLevel} />
				<Box>
					<Typography variant="body2" color="text.secondary" gutterBottom>
						Dummy links
					</Typography>
					<ToggleButtonGroup exclusive size="small" value={setup.links} onChange={(_event, value: number | null) => value !== null && onChange({ links: value })} aria-label="Dummy links">
						{LINK_COUNTS.map((count) => (
							<ToggleButton key={count} value={count}>
								{count}
							</ToggleButton>
						))}
					</ToggleButtonGroup>
				</Box>
				<Box>
					<Typography variant="body2" color="text.secondary" gutterBottom>
						Affection
					</Typography>
					<ToggleButtonGroup
						exclusive
						size="small"
						value={setup.affection}
						onChange={(_event, value: AffectionLevel | null) => value !== null && onChange({ affection: value })}
						aria-label="Affection"
					>
						{AFFECTION_LABELS.map((label, index) => (
							<ToggleButton key={label} value={index}>
								{label}
							</ToggleButton>
						))}
					</ToggleButtonGroup>
				</Box>
				<Box sx={{ display: "flex", gap: 2, flexWrap: "wrap" }}>
					<SkillLevelSelect label="Skill 1 level" value={setup.skill1} onChange={(skill1) => onChange({ skill1 })} />
					{setup.modStage > 0 && result?.form.hasSkill2 && <SkillLevelSelect label="Skill 2 level" value={setup.skill2} onChange={(skill2) => onChange({ skill2 })} />}
				</Box>
				<Typography variant="caption" color="text.secondary">
					Skill levels start affecting the numbers once skill buffs arrive with damage estimates.
				</Typography>
			</Box>
		</Box>
	);
});
