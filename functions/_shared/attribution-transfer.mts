/** Transfer debits are derived from the approved request, never separately saved. */
export const isTransfer = (r:any) => String(r?.adjustmentReason || r?.reason || '').trim() === 'Shifting Attro Between Reps';
export function validateTransfer(record:any, value:any, names:string[]) {
 const name=String(value?.repName||'').trim(), manager=String(value?.managerName||'').trim();
 if(!name||!manager||name.length>150||manager.length>150)throw Error('Enter the rep losing credit and their manager (up to 150 characters each).');
 const canonical=names.find(n=>n.toLowerCase()===name.toLowerCase())||name;
 if(canonical.toLowerCase()===String(record.repName||'').trim().toLowerCase())throw Error('The rep losing credit must be different from the receiving rep.');
 if(!Number.isFinite(Number(record.members))||!Number.isFinite(Number(record.sessions))||Number(record.members)<0||Number(record.sessions)<0)throw Error('Transfer amounts must be nonnegative.');
 return {repName:canonical,managerName:manager};
}
export function expandTransfers(records:any[]) {
 return records.flatMap(r=>{
  if(r.status!=='approved'||!isTransfer(r)||!r.transferFrom?.repName||r.transferDebit)return [r];
  return [r,{...r,id:r.id+':transfer-debit',transferDebit:true,parentId:r.id,repName:r.transferFrom.repName,repEmail:r.transferFrom.repEmail||'',managerName:r.transferFrom.managerName,members:-Number(r.members),sessions:-Number(r.sessions),comments:'Credit transferred to '+r.repName,transferFrom:undefined}];
 });
}
