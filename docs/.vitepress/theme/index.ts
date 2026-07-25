// Default VitePress theme plus the styles the hand-authored diagrams
// need. The diagrams live inline in the markdown so they can read the
// theme's own custom properties and follow the light/dark toggle.

import DefaultTheme from "vitepress/theme";

import "./diagrams.css";

export default DefaultTheme;
