function uploadSelector(token) {
  if (typeof token !== 'string' || !/^coo-upload-[\da-f-]{36}$/.test(token)) throw new Error('invalid file input token');
  return `input[type="file"][data-coo-upload-token="${token}"]`;
}

async function setFileInputFiles(debuggerClient, token, files) {
  if (!Array.isArray(files) || !files.length || files.some((file) => typeof file !== 'string' || !file)) throw new Error('file selection needs absolute paths');
  const selector = uploadSelector(token);
  if (debuggerClient.isAttached()) throw new Error('the browser has another debugging session; file selection was refused');
  debuggerClient.attach('1.3');
  try {
    await debuggerClient.sendCommand('DOM.enable');
    const { root } = await debuggerClient.sendCommand('DOM.getDocument', { depth: 1 });
    const { nodeId } = await debuggerClient.sendCommand('DOM.querySelector', {
      nodeId: root.nodeId,
      selector,
    });
    if (!nodeId) throw new Error('the selected file input is no longer on the page');
    await debuggerClient.sendCommand('DOM.setFileInputFiles', { nodeId, files });
  } finally {
    if (debuggerClient.isAttached()) debuggerClient.detach();
  }
}

module.exports = { setFileInputFiles, uploadSelector };
