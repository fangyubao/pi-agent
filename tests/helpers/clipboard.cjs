'use strict';
// Deterministic OS boundary for UI tests. Product IPC, path validation and
// write/readback verification still execute. Real OS failure is tested separately.
async function useClipboardMemory(app){
  await app.evaluate(({clipboard})=>{let value='';clipboard.writeText=text=>{value=String(text);};clipboard.readText=()=>value;});
}
module.exports={useClipboardMemory};
