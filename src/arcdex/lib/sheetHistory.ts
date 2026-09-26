// Bottom sheets add a history entry so the phone's Back gesture closes them.
// The page router (App.tsx) must not treat those pops as page navigation:
// `open` > 0 while a sheet is up, and `ignoreNextPop` is set when a sheet
// closes itself by stepping back over its own entry.
export const sheetHistory = { open: 0, ignoreNextPop: false }
