import {open} from 'node:fs/promises'
// Single-use durable reservation. Never release/retry on unknown charge or crash.
// Same ledger path is the entire local trial budget, not a production quota.
export function localDocumentReservation(path) {
  return async reservation => {
    const handle=await open(path,'wx',0o600)
    try {await handle.writeFile(JSON.stringify({status:'reserved',...reservation})+'\n');await handle.sync()} finally {await handle.close()}
    return {async settle(usage) {
      const result=await open(path+'.settled','wx',0o600)
      try {await result.writeFile(JSON.stringify({status:'settled',...usage})+'\n');await result.sync()} finally {await result.close()}
    }}
  }
}
