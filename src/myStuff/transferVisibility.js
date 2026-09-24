export function excludeTransferredItems(items=[],transfers=[]){const ids=new Set(transfers.map(row=>row?.item_id).filter(Boolean));return items.filter(item=>!ids.has(item.id))}
