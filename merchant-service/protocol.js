const crypto=require('node:crypto');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const sign=(key,ts,id,method,path,body)=>crypto.createHmac('sha256',key).update([ts,id,method,path,hash(body)].join('\n')).digest('hex');
const safe=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));
module.exports={hash,sign,safe};
