require('dotenv').config({quiet:true});
const {AIProvider}=require('../server/services/ai-provider');
(async()=>{
 const result=await new AIProvider().analyze({name:'Connection check',description:'One office chair',budgetCents:20000,needBy:'2030-01-01'});
 if(!result.products.length)throw new Error('The model did not identify a product.');
 console.log('Nebius connection works. Nemotron returned valid purchase information.');
})().catch(error=>{console.error(`Nebius connection check failed: ${error.message}`);process.exitCode=1});
