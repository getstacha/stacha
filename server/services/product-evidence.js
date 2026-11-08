// Evidence comes from the listing, and is not independently verified.
const countUnit = /\b(pencils?|pens?|batter(?:y|ies)|cups?|boxes|box|labels?|bottles?|reams?)\b/i;
function listingText(o){return [o?.name, ...(o?.features||[]),o?.description,JSON.stringify(o?.attributes||{}),JSON.stringify(o?.variants?.selected||[])].filter(Boolean).join(' ')}
function productMatch(req,offer){
 const name=String(req?.name||'').toLowerCase(), title=String(offer?.name||'').toLowerCase();
 if(/\b(ink|toner|cartridge)\b/.test(name)){
  if(/\b(?:fountain|ballpoint|rollerball)\s+pen\b/.test(title)&&!/\bpen\b/.test(name))return false;
  if(/\b(printer|all.in.one)\b/.test(title)&&!/\b(?:ink|toner)\s+cartridge\b|\brefill\b|\b(?:ink|toner)\s+bottle\b/.test(title))return false;
  if(!/\b(ink|toner|cartridge|refill)\b/.test(title))return false;
  for(const spec of req.specifications||[]){if(!/compatible with/i.test(spec))continue;for(const model of spec.match(/\b\d{3,}\b/g)||[])if(!new RegExp(`\\b${model}\\b`,'i').test(listingText(offer)))return false;}
 }
 if(/\bpencils?\b/.test(name)&&!/(?:^|\b)pencils?\b/.test(title))return false;
 if(/\bbatter(?:y|ies)\b/.test(name)&&!/\bbatter(?:y|ies)\b/.test(title))return false;
 if(/\b(?:printer|copy) paper\b|\breams?\b/.test(name)&&!/\b(paper|ream)\b/.test(title))return false;
 if(/\bvacuum(?: cleaner)?\b/.test(name)&&/\b(filter|replacement|bags?|parts?|accessor(?:y|ies)|attachment|brush roll)\b/.test(title)&&!/\b(with|includes?)\s+(?:a\s+)?filter\b/.test(title))return false;
 if(/\bcoffee beans?\b/.test(name)&&(/\b(letterhead|stationery|fabric|textile|print|art|poster|candle|mug|t.?shirt|decor|book|ornament|journal|notebook|planner|calendar|sticker|puzzle|toy)\b/.test(title)||offer?.attributes?.genre||!/\b(roast(?:ed)?|arabica|robusta|whole.bean|coffee blend)\b/i.test(listingText(offer))))return false;
 if(/\b(?:paper|drinking) cups?\b/.test(name)&&/\b(baking|cupcake|muffin)\b/.test(title))return false;
 if(/\bblack\b/.test(name)&&/\b(color|colour|cyan|magenta|yellow|tri.color)\b/.test(title)&&!/\bblack\b/.test(title))return false;
 return true;
}
function packDetails(req,offer){
 const needed=req.quantity;
 if(!countUnit.test([req.name,...(req.specifications||[])].join(' ')))return {requestedQuantity:needed,packSize:null,quantity:needed,packStatus:'not_applicable'};
 const str=listingText(offer),numbers=[],reams=/\breams?\b/i.test([req.name,...(req.specifications||[])].join(' '));
 const patterns=[/\b(?:pack|box|set)\s+of\s+(\d{1,4})\b/gi,/\b(\d{1,4})\s*[- ]\s*(?:pack|count|ct)\b/gi,/\b(\d{1,4})\s+(?:pencils?|pens?|batter(?:y|ies)|cups?|boxes|labels?|bottles?|reams?)\b/gi];
 for(const p of (reams?[/\b(\d{1,4})\s+reams?\b/gi]:patterns))for(const m of str.matchAll(p)){const n=Number(m[1]);if(n>0&&n<=10000)numbers.push(n)}
 // A ream contains sheets, not reams; a sheet count does not multiply reams.
 if(reams&&!numbers.length&&/\b(?:a|one|1)\s+ream\b/i.test(str))numbers.push(1);
 const unique=[...new Set(numbers)];
 if(unique.length!==1){if(needed===1)return {requestedQuantity:needed,packSize:null,quantity:1,packStatus:'unknown'};return {requestedQuantity:needed,packSize:null,quantity:null,packStatus:'unknown'}}
 return {requestedQuantity:needed,packSize:unique[0],quantity:Math.ceil(needed/unique[0]),packStatus:'listing_reported'};
}
function specificationWarnings(req,offer){const expected=[req.name,...(req.specifications||[])].join(' '),actual=listingText(offer),warnings=[];for(const [re,label] of [[/\bA4\b/i,'A4 paper size'],[/\bDDR5\b/i,'DDR5'],[/\bDDR4\b/i,'DDR4'],[/\bAM5\b/i,'AM5 socket'],[/\bAM4\b/i,'AM4 socket'],[/\b65\s*W\b/i,'65 W power']])if(re.test(expected)&&!re.test(actual))warnings.push(`${label} is not confirmed by this listing.`);for(const spec of req.specifications||[]){if(!/compatible with/i.test(spec))continue;for(const model of spec.match(/\b\d{3,}\b/g)||[])if(!new RegExp(`\\b${model}\\b`,'i').test(actual))warnings.push(`Compatibility with model ${model} is not confirmed by this listing.`)}return warnings}
module.exports={productMatch,packDetails,specificationWarnings};
