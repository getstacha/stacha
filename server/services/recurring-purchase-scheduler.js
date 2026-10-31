class RecurringPurchaseScheduler {
 constructor({runDue,intervalMs=60000}){this.runDue=runDue;this.intervalMs=intervalMs;this.timer=null;this.running=false}
 start(){if(this.timer)return;this.timer=setInterval(async()=>{if(this.running)return;this.running=true;try{await this.runDue()}catch(e){console.error('Recurring check:',e.message)}finally{this.running=false}},this.intervalMs);this.timer.unref()}
 stop(){clearInterval(this.timer);this.timer=null}
}
module.exports={RecurringPurchaseScheduler};
