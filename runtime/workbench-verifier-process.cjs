'use strict';
process.once('message', async ({ root, timeoutMs, isolationPath, evidencePath }) => {
  const verifier = require('./workbench-lifecycle-verification.cjs').createVerifier({ timeoutMs, inProcess: true, isolationPath, evidencePath });
  const result = await verifier.verify(root);
  process.send(result);
});
