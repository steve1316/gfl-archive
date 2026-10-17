import { useLayoutEffect } from "react";
import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";

/** Props for ScrollToTopOnNavigate. */
interface ScrollToTopOnNavigateProps {
	/** The routed tree to render. */
	children: ReactNode;
}

/**
 * Scrolls back to the top whenever the route changes.
 *
 * Replaces `react-router-scroll-top`, which ships no types and is tied to react-router v5, so it
 * would have blocked the router upgrade. The behaviour is a few lines, so it lives here instead.
 *
 * @param props Component props.
 * @returns The children, unchanged.
 */
export default function ScrollToTopOnNavigate({ children }: ScrollToTopOnNavigateProps) {
	const { pathname } = useLocation();

	// A layout effect runs before the new page's own effects, so a page that scrolls itself on arrival is not undone, and before paint.
	useLayoutEffect(() => {
		window.scrollTo(0, 0);
	}, [pathname]);

	return <>{children}</>;
}
