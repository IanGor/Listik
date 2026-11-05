// Run by the Electron binary, not node. The parent Playwright runner owns the servers/profile.
const { start } = require('../main.cjs');
const { app } = require('electron');
void start({ site: process.env.LISTIK_TEST_SITE, profile: process.env.LISTIK_TEST_PROFILE, themeRoot: process.env.LISTIK_TEST_THEME }).catch((error) => { console.error(error); app.exit(1); });
