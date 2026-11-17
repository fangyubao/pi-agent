'use strict';
// The verifier is a separate Electron process; it never loads the user's profile.
if (process.argv.includes('--pi-workbench-ui-verifier')) require('./runtime/workbench-frontend-process.cjs');
else require('./main.cjs');
