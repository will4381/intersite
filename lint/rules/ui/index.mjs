// @ts-check
// Code rules for the ui area (pack `ui`, design-system discipline) and global state (pack `globals`).
import * as noArbitraryScaleValue from "./no-arbitrary-scale-value.mjs";
import * as noExportedMutableState from "./no-exported-mutable-state.mjs";
import * as noGlobalAssignment from "./no-global-assignment.mjs";
import * as noHandStyledControl from "./no-hand-styled-control.mjs";
import * as noHardcodedColor from "./no-hardcoded-color.mjs";
import * as noHardcodedTypography from "./no-hardcoded-typography.mjs";
import * as noRawPaletteColor from "./no-raw-palette-color.mjs";
import * as noStaticInlineStyle from "./no-static-inline-style.mjs";

/** @type {{ id: string, pack: string, rule: unknown, bad: string[], good: string[], ext?: string }[]} */
export default [
  noArbitraryScaleValue,
  noExportedMutableState,
  noGlobalAssignment,
  noHandStyledControl,
  noHardcodedColor,
  noHardcodedTypography,
  noRawPaletteColor,
  noStaticInlineStyle,
];
