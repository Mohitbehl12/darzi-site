// Regenerates server/pricing.json from the price tables in index.html,
// so the server and the website always charge the same amount.
// Run: node tools/extract-pricing.js
const fs=require('fs'),path=require('path');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const js=html.slice(html.indexOf('const COLORS='),html.indexOf('function price('));
const fn=new Function(js+';return {fabric:FABRIC,patCost:PAT_COST,cats:Object.fromEntries(Object.entries(CATS).map(([k,c])=>[k,{name:c.one,base:c.base,days:c.days}]))}');
fs.writeFileSync(path.join(__dirname,'..','server','pricing.json'),JSON.stringify(fn(),null,1)+'\n');
console.log('server/pricing.json updated');
