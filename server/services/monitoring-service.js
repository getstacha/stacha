class MonitoringService {
 constructor(search){this.search=search}
 async refresh(project){const research=[];for(let i=0;i<project.interpretation.products.length;i++){const product=project.interpretation.products[i];if((project.externalPurchases||[]).some(x=>x.requirementIndex===i&&x.status!=='RETRACTED')||(project.removedRequirementIndices||[]).includes(i))continue;const query=(product.searchQuery||[product.name,...product.specifications].join(' ')).slice(0,500);research.push({requirementIndex:i,query,offers:await this.search.search(query)});}return research}
 compare(oldResearch,newResearch){const changes=[];for(const group of oldResearch||[])for(const old of group.offers||[]){const current=newResearch.find(g=>g.requirementIndex===group.requirementIndex)?.offers.find(o=>o.id===old.id);if(!current)changes.push(`${old.name}: offer not returned in latest search; availability unknown.`);else if(current.unitCents!==old.unitCents||current.availability!==old.availability)changes.push(`${old.name}: price or availability changed.`)}return changes.slice(0,100)}
}
module.exports={MonitoringService};
