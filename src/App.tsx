import { lazy, Suspense } from "react";

import { CssBaseline, ThemeProvider } from "@mui/material";
import { Route, Routes } from "react-router-dom";

import Navbar from "./components/Navbar";
import NotFound404 from "./not_found_404";
import EquipmentIndex from "./pages/equipment_index/equipment_index";
import Home from "./pages/home/home";
import TDoll from "./pages/tdoll/tdoll";
import TDollArt from "./pages/tdoll_art/tdoll_art";
import TDollIndex from "./pages/tdoll_index/tdoll_index";

import { theme } from "./theme";

import "./styles.css";

/** The HOC pages load on first visit, since few readers open them and they would otherwise add ~4.5 KB gzip to every route. */
const HOCIndex = lazy(() => import("./pages/hoc_index/hoc_index"));
const HOCPage = lazy(() => import("./pages/hoc/hoc"));

/** The Fairy pages load on first visit, for the same reason as the HOC pages. */
const FairyIndex = lazy(() => import("./pages/fairy_index/fairy_index"));
const FairyPage = lazy(() => import("./pages/fairy/fairy"));
const FairyArt = lazy(() => import("./pages/fairy_art/fairy_art"));
const FairyLive2d = lazy(() => import("./pages/fairy_live2d/fairy_live2d"));

/** The Enemy pages load on first visit, since they ship their own data files that no other route needs. */
const EnemyIndex = lazy(() => import("./pages/enemy_index/enemy_index"));
const EnemyPage = lazy(() => import("./pages/enemy/enemy"));
const EnemyArt = lazy(() => import("./pages/enemy_art/enemy_art"));

/** The T-Doll skin Live2D viewer loads on first visit, since few readers open it and it would otherwise add to every T-Doll route. */
const TDollLive2d = lazy(() => import("./pages/tdoll_live2d/tdoll_live2d"));

/** The Formation Simulator loads on first visit, since it ships its own data files that no other route needs. */
const FormationSimulator = lazy(() => import("./pages/formation_simulator/formation_simulator"));

/** The story routes load on first visit. The player pulls one scene file at a time, none of which any other route needs. */
const StoryIndex = lazy(() => import("./pages/story_index/story_index"));
const Story = lazy(() => import("./pages/story/story"));

/**
 * The application shell: theme, navigation and routes.
 *
 * @returns The routed application.
 */
export default function App() {
	return (
		<ThemeProvider theme={theme}>
			<CssBaseline />
			<Navbar />
			<div className="App">
				<Routes>
					<Route path="/" element={<Home />} />
					<Route path="/index" element={<TDollIndex />} />
					<Route path="/equipment-index" element={<EquipmentIndex />} />
					<Route
						path="/hoc-index"
						element={
							<Suspense>
								<HOCIndex />
							</Suspense>
						}
					/>
					<Route
						path="/hoc/:id"
						element={
							<Suspense>
								<HOCPage />
							</Suspense>
						}
					/>
					<Route
						path="/fairy-index"
						element={
							<Suspense>
								<FairyIndex />
							</Suspense>
						}
					/>
					<Route
						path="/fairy/:id/art"
						element={
							<Suspense>
								<FairyArt />
							</Suspense>
						}
					/>
					<Route
						path="/fairy/:id/live2d"
						element={
							<Suspense>
								<FairyLive2d />
							</Suspense>
						}
					/>
					<Route
						path="/fairy/:id"
						element={
							<Suspense>
								<FairyPage />
							</Suspense>
						}
					/>
					<Route
						path="/enemy-index"
						element={
							<Suspense>
								<EnemyIndex />
							</Suspense>
						}
					/>
					<Route
						path="/enemy/:id/art"
						element={
							<Suspense>
								<EnemyArt />
							</Suspense>
						}
					/>
					<Route
						path="/enemy/:id"
						element={
							<Suspense>
								<EnemyPage />
							</Suspense>
						}
					/>
					<Route
						path="/formation"
						element={
							<Suspense>
								<FormationSimulator />
							</Suspense>
						}
					/>
					<Route path="/tdoll/:id/art" element={<TDollArt />} />
					<Route
						path="/tdoll/:id/live2d"
						element={
							<Suspense>
								<TDollLive2d />
							</Suspense>
						}
					/>
					<Route
						path="/story/:chapter/:scene"
						element={
							<Suspense>
								<Story />
							</Suspense>
						}
					/>
					<Route
						path="/story/:chapter?"
						element={
							<Suspense>
								<StoryIndex />
							</Suspense>
						}
					/>
					<Route path="/tdoll/:id" element={<TDoll />} />
					<Route path="/tdoll" element={<TDoll />} />
					<Route path="/404" element={<NotFound404 />} />
					{/* Anything unmatched shows the 404 page in place, keeping the mistyped address visible. */}
					<Route path="*" element={<NotFound404 />} />
				</Routes>
			</div>
		</ThemeProvider>
	);
}
